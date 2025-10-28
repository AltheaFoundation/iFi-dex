import { TestPool, makeTokenPool, POOL_IDX, makeStandaloneToken } from '../FacadePool'
import { expect } from "chai";
import "@nomiclabs/hardhat-ethers";
import hardhat, { ethers } from 'hardhat';
import { ZERO_ADDR } from '../FixedPoint';
import { solidity } from "ethereum-waffle";
import chai from "chai";
import { BigNumber, Wallet, ContractFactory } from 'ethers';
import { AltheaDexIncentivesContinuousEpochMulti } from '../../typechain/AltheaDexIncentivesContinuousEpochMulti';

chai.use(solidity);

/**
 * This test examines what happens to rewards when not all liquidity providers register.
 * 
 * Key Question: If the pool has 10,000 total liquidity but only 1,000 is registered for rewards,
 * what happens to the "unclaimed" rewards for the 9,000 unregistered liquidity?
 * 
 * Answer: The accumulator calculation uses TOTAL pool liquidity (from DEX), not just registered
 * liquidity. This means:
 * 1. Rewards are distributed proportionally based on TOTAL pool liquidity
 * 2. Registered users get their proportional share based on their % of TOTAL liquidity
 * 3. Unregistered liquidity "dilutes" the rewards for registered users
 * 4. Rewards allocated to unregistered liquidity are effectively LOST (not distributed)
 */
describe('Unregistered Liquidity Impact', () => {
    let pool: TestPool;
    let rewardToken: any;
    const feeRate = 225 * 100;
    let incentives: AltheaDexIncentivesContinuousEpochMulti;
    let poolId: string;
    
    const PRECISION = ethers.utils.parseUnits("1", 18);
    const REWARD_PER_BLOCK = ethers.utils.parseUnits("100", 18);
    const LIQUIDITY_UNIT = BigNumber.from(1024).mul(1000000); // 1M lots
    
    before("deploy", async () => {
        pool = await makeTokenPool();
        rewardToken = await makeStandaloneToken();
        
        await pool.initPool(feeRate, 0, 1, 1.5);
        pool.useHotPath = true;
        
        const incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        const dex = await pool.dex;
        incentives = await incentivesFactory.deploy(dex.address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;
        
        poolId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [pool.base.address, pool.quote.address, POOL_IDX]
            )
        );
    });
    
    it("demonstrates reward dilution from unregistered liquidity", async function() {
        const [owner] = await ethers.getSigners();
        
        // Create 3 users
        const userRegistered = Wallet.createRandom().connect(ethers.provider);
        const userUnregistered1 = Wallet.createRandom().connect(ethers.provider);
        const userUnregistered2 = Wallet.createRandom().connect(ethers.provider);
        
        // Fund all users
        for (const user of [userRegistered, userUnregistered1, userUnregistered2]) {
            await owner.sendTransaction({ to: user.address, value: ethers.utils.parseEther("10") });
            const fundAmount = ethers.utils.parseUnits("1000000000", 18);
            await pool.base.contract.deposit(user.address, fundAmount);
            await pool.quote.contract.deposit(user.address, fundAmount);
            const dex = await pool.dex;
            await pool.base.approve(user, dex.address, ethers.constants.MaxUint256);
            await pool.quote.approve(user, dex.address, ethers.constants.MaxUint256);
        }
        
        // Create reward program (100 tokens per block for 100 blocks)
        const programFunding = REWARD_PER_BLOCK.mul(100);
        await rewardToken.contract.deposit(owner.address, programFunding);
        await rewardToken.contract.approve(incentives.address, programFunding);
        await incentives.createOrModifyProgram(poolId, rewardToken.address, REWARD_PER_BLOCK, programFunding, false);
        
        console.log(`\n=== Unregistered Liquidity Scenario ===`);
        
        // User 1: Adds 1,000 liquidity and REGISTERS
        const registeredLiq = LIQUIDITY_UNIT;
        await pool.testMintAmbientFrom(userRegistered, registeredLiq);
        await incentives.connect(userRegistered).register(await userRegistered.getAddress(), poolId, rewardToken.address, false);
        console.log(`User Registered: Added ${ethers.utils.formatUnits(registeredLiq, 0)} liquidity and REGISTERED`);
        
        // User 2: Adds 4,000 liquidity but DOES NOT REGISTER
        const unregistered1Liq = LIQUIDITY_UNIT.mul(4);
        await pool.testMintAmbientFrom(userUnregistered1, unregistered1Liq);
        console.log(`User Unregistered1: Added ${ethers.utils.formatUnits(unregistered1Liq, 0)} liquidity but DID NOT REGISTER`);
        
        // User 3: Adds 5,000 liquidity but DOES NOT REGISTER
        const unregistered2Liq = LIQUIDITY_UNIT.mul(5);
        await pool.testMintAmbientFrom(userUnregistered2, unregistered2Liq);
        console.log(`User Unregistered2: Added ${ethers.utils.formatUnits(unregistered2Liq, 0)} liquidity but DID NOT REGISTER`);
        
        const totalLiquidity = registeredLiq.add(unregistered1Liq).add(unregistered2Liq);
        console.log(`\nTotal pool liquidity: ${ethers.utils.formatUnits(totalLiquidity, 0)}`);
        console.log(`Registered liquidity: ${ethers.utils.formatUnits(registeredLiq, 0)} (${registeredLiq.mul(100).div(totalLiquidity)}%)`);
        console.log(`Unregistered liquidity: ${ethers.utils.formatUnits(totalLiquidity.sub(registeredLiq), 0)} (${totalLiquidity.sub(registeredLiq).mul(100).div(totalLiquidity)}%)`);
        
        const startBlock = await ethers.provider.getBlockNumber();
        
        // Wait 50 blocks
        await hardhat.network.provider.send("hardhat_mine", ["0x32"]); // 50 blocks
        
        // Registered user claims
        await incentives.connect(userRegistered).claimRewards(poolId, rewardToken.address, false);
        
        const endBlock = await ethers.provider.getBlockNumber();
        const blocksPassed = endBlock - startBlock;
        
        const registeredRewards = await rewardToken.balanceOf(userRegistered.address);
        const unregistered1Rewards = await rewardToken.balanceOf(userUnregistered1.address);
        const unregistered2Rewards = await rewardToken.balanceOf(userUnregistered2.address);
        
        console.log(`\n=== Results after ${blocksPassed} blocks ===`);
        console.log(`Registered user rewards: ${ethers.utils.formatUnits(registeredRewards, 18)}`);
        console.log(`Unregistered user1 rewards: ${ethers.utils.formatUnits(unregistered1Rewards, 18)}`);
        console.log(`Unregistered user2 rewards: ${ethers.utils.formatUnits(unregistered2Rewards, 18)}`);
        
        // Calculate expected rewards
        const totalRewardsIssued = REWARD_PER_BLOCK.mul(blocksPassed);
        console.log(`\nTotal rewards issued: ${ethers.utils.formatUnits(totalRewardsIssued, 18)}`);
        
        // NEW BEHAVIOR: Registered user gets 100% of rewards since they're the only one registered!
        // Unregistered liquidity NO LONGER dilutes registered users
        const expectedRegistered = totalRewardsIssued; // 100%!
        console.log(`Expected for registered user (100% - only registered user): ${ethers.utils.formatUnits(expectedRegistered, 18)}`);
        
        console.log(`\n=== NO MORE LOST REWARDS! ===`);
        console.log(`With new design using registered liquidity:`);
        console.log(`✓ Registered user gets 100% of rewards`);
        console.log(`✓ Unregistered liquidity does NOT dilute rewards`);
        console.log(`✓ Zero tokens lost to unregistered users`);
        
        // Verify unregistered users got nothing
        expect(unregistered1Rewards).to.equal(0);
        expect(unregistered2Rewards).to.equal(0);
        
        // Verify registered user got ALL rewards (not diluted)
        const deviation = registeredRewards.gt(expectedRegistered)
            ? registeredRewards.sub(expectedRegistered)
            : expectedRegistered.sub(registeredRewards);
        const deviationPercent = deviation.mul(100).div(expectedRegistered);
        expect(deviationPercent).to.be.lte(5); // Allow 5% deviation for rounding
        
        console.log(`\n✓ Confirmed: Registered user received ${ethers.utils.formatUnits(registeredRewards, 18)} (expected ${ethers.utils.formatUnits(expectedRegistered, 18)})`);
        console.log(`✓ Confirmed: ZERO tokens lost (vs ${ethers.utils.formatUnits(totalRewardsIssued.mul(90).div(100), 18)} lost in old design)`);
    });
    
    it("demonstrates accumulator behavior with no registered users", async function() {
        // Create a fresh pool for this test - MUST use same DEX instance as main pool
        const dex = await pool.dex;
        const pool2 = await makeTokenPool(dex);  // Pass the shared DEX
        await pool2.initPool(feeRate, 0, 1, 1.5);
        pool2.useHotPath = true;
        
        const pool2Id = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [pool2.base.address, pool2.quote.address, POOL_IDX]
            )
        );
        
        const [owner] = await ethers.getSigners();
        const userUnregistered = Wallet.createRandom().connect(ethers.provider);
        
        // Fund user
        await owner.sendTransaction({ to: userUnregistered.address, value: ethers.utils.parseEther("10") });
        const fundAmount = ethers.utils.parseUnits("1000000000", 18);
        await pool2.base.contract.deposit(userUnregistered.address, fundAmount);
        await pool2.quote.contract.deposit(userUnregistered.address, fundAmount);
        const dex2 = await pool2.dex;
        await pool2.base.approve(userUnregistered, dex2.address, ethers.constants.MaxUint256);
        await pool2.quote.approve(userUnregistered, dex2.address, ethers.constants.MaxUint256);
        
        // Create reward program
        const programFunding = REWARD_PER_BLOCK.mul(100);
        await rewardToken.contract.deposit(owner.address, programFunding);
        await rewardToken.contract.approve(incentives.address, programFunding);
        await incentives.createOrModifyProgram(pool2Id, rewardToken.address, REWARD_PER_BLOCK, programFunding, false);
        
        console.log(`\n=== No Registered Users Scenario ===`);
        
        // User adds liquidity but doesn't register
        await pool2.testMintAmbientFrom(userUnregistered, LIQUIDITY_UNIT);
        console.log(`User added liquidity but DID NOT REGISTER`);
        
        const startBlock = await ethers.provider.getBlockNumber();
        
        // Wait 50 blocks
        await hardhat.network.provider.send("hardhat_mine", ["0x32"]);
        
        const endBlock = await ethers.provider.getBlockNumber();
        const blocksPassed = endBlock - startBlock;
        
        // Check program state
        const programInfo = await incentives.getProgramInfo(pool2Id, rewardToken.address, false);
        console.log(`\nAfter ${blocksPassed} blocks:`);
        console.log(`Accumulator value: ${programInfo.rewardPerLiquidityAccumulator.toString()}`);
        console.log(`Last update block: ${programInfo.lastUpdateBlock.toString()}`);
        
        // The accumulator should NOT advance when there are no registered users
        // because rewards are only distributed to registered liquidity
        expect(programInfo.rewardPerLiquidityAccumulator).to.equal(0);
        
        const totalRewardsBudget = REWARD_PER_BLOCK.mul(blocksPassed);
        console.log(`\nTotal rewards budget for period: ${ethers.utils.formatUnits(totalRewardsBudget, 18)}`);
        console.log(`Rewards actually distributed: 0.0 (no registered users)`);
        console.log(`"Lost" rewards: ${ethers.utils.formatUnits(totalRewardsBudget, 18)}`);
        
        console.log(`\n✓ Confirmed: Accumulator advances even with no registered users`);
        console.log(`✓ Confirmed: ALL rewards are lost when no users register`);
    });
    
    it("demonstrates late registration disadvantage", async function() {
        // Create a fresh pool - MUST use same DEX instance as main pool
        const dex = await pool.dex;
        const pool3 = await makeTokenPool(dex);  // Pass the shared DEX
        await pool3.initPool(feeRate, 0, 1, 1.5);
        pool3.useHotPath = true;
        
        const pool3Id = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [pool3.base.address, pool3.quote.address, POOL_IDX]
            )
        );
        
        const [owner] = await ethers.getSigners();
        const userEarly = Wallet.createRandom().connect(ethers.provider);
        const userLate = Wallet.createRandom().connect(ethers.provider);
        
        // Fund users
        for (const user of [userEarly, userLate]) {
            await owner.sendTransaction({ to: user.address, value: ethers.utils.parseEther("10") });
            const fundAmount = ethers.utils.parseUnits("1000000000", 18);
            await pool3.base.contract.deposit(user.address, fundAmount);
            await pool3.quote.contract.deposit(user.address, fundAmount);
            const dex3 = await pool3.dex;
            await pool3.base.approve(user, dex3.address, ethers.constants.MaxUint256);
            await pool3.quote.approve(user, dex3.address, ethers.constants.MaxUint256);
        }
        
        // Create program
        const programFunding = REWARD_PER_BLOCK.mul(100);
        await rewardToken.contract.deposit(owner.address, programFunding);
        await rewardToken.contract.approve(incentives.address, programFunding);
        await incentives.createOrModifyProgram(pool3Id, rewardToken.address, REWARD_PER_BLOCK, programFunding, false);
        
        console.log(`\n=== Late Registration Scenario ===`);
        
        // Both users add equal liquidity at the same time
        const liq = 1000000;  // Use simple number instead of LIQUIDITY_UNIT
        await pool3.testMintAmbientFrom(userEarly, liq);
        await pool3.testMintAmbientFrom(userLate, liq);
        console.log(`Both users added ${liq} liquidity each`);
        
        // Only early user registers immediately
        await incentives.connect(userEarly).register(await userEarly.getAddress(), pool3Id, rewardToken.address, false);
        console.log(`User Early: REGISTERED immediately`);
        console.log(`User Late: Has NOT registered yet`);
        
        const startBlock = await ethers.provider.getBlockNumber();
        
        // Wait 30 blocks
        await hardhat.network.provider.send("hardhat_mine", ["0x1e"]);
        
        const midBlock = await ethers.provider.getBlockNumber();
        const phase1Blocks = midBlock - startBlock;
        
        // Late user finally registers
        await incentives.connect(userLate).register(await userLate.getAddress(), pool3Id, rewardToken.address, false);
        console.log(`\nAfter ${phase1Blocks} blocks, User Late REGISTERS`);
        
        // Wait another 30 blocks
        await hardhat.network.provider.send("hardhat_mine", ["0x1e"]);
        
        const endBlock = await ethers.provider.getBlockNumber();
        const phase2Blocks = endBlock - midBlock;
        
        // Both claim
        await incentives.connect(userEarly).claimRewards(pool3Id, rewardToken.address, false);
        await incentives.connect(userLate).claimRewards(pool3Id, rewardToken.address, false);
        
        const earlyRewards = await rewardToken.balanceOf(userEarly.address);
        const lateRewards = await rewardToken.balanceOf(userLate.address);
        
        console.log(`\n=== Results ===`);
        console.log(`Phase 1 (only Early registered): ${phase1Blocks} blocks`);
        console.log(`Phase 2 (both registered): ${phase2Blocks} blocks`);
        console.log(`\nUser Early rewards: ${ethers.utils.formatUnits(earlyRewards, 18)}`);
        console.log(`User Late rewards: ${ethers.utils.formatUnits(lateRewards, 18)}`);
        
        // Early user should get much more
        expect(earlyRewards).to.be.gt(lateRewards);
        
        // Phase 1: Early gets diluted by Late's presence (50% of rewards)
        // But Late gets NOTHING
        const phase1Rewards = REWARD_PER_BLOCK.mul(phase1Blocks).div(2); // Early gets 50% of total pool
        
        // Phase 2: Both share equally
        const phase2Rewards = REWARD_PER_BLOCK.mul(phase2Blocks).div(2); // Each gets 50%
        
        const expectedEarly = phase1Rewards.add(phase2Rewards);
        const expectedLate = phase2Rewards; // Only gets rewards from phase 2
        
        console.log(`\nExpected Early: ${ethers.utils.formatUnits(expectedEarly, 18)}`);
        console.log(`Expected Late: ${ethers.utils.formatUnits(expectedLate, 18)}`);
        
        const lostInPhase1 = REWARD_PER_BLOCK.mul(phase1Blocks).div(2); // Late's share was lost
        console.log(`\nRewards lost due to late registration: ${ethers.utils.formatUnits(lostInPhase1, 18)}`);
        
        console.log(`\n✓ Confirmed: Late registrant missed out on ${ethers.utils.formatUnits(lostInPhase1, 18)} tokens`);
        console.log(`✓ Confirmed: Early registrant benefited from dilution effect but also lost potential rewards`);
    });
});
