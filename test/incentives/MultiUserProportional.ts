import { TestPool, makeTokenPool, Token, makeEtherPool, POOL_IDX, ERC20Token, makeStandaloneToken, makeTokenTriangle } from '../FacadePool'
import { expect } from "chai";
import "@nomiclabs/hardhat-ethers";
import hardhat, { ethers } from 'hardhat';
import { toSqrtPrice, fromSqrtPrice, maxSqrtPrice, minSqrtPrice, ZERO_ADDR } from '../FixedPoint';
import { solidity } from "ethereum-waffle";
import chai from "chai";
import { MockERC20 } from '../../typechain/MockERC20';
import { BigNumber, ContractFactory } from 'ethers';
import { HotProxy, AltheaDexIncentivesContinuousEpochMulti } from '../../typechain';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

chai.use(solidity);

describe('MultiUserProportional - Per-Block Incentives', () => {
    let test1: TestPool
    let test2: TestPool
    let test3: TestPool
    let baseToken: ERC20Token
    let quoteToken: ERC20Token
    let rewardToken: ERC20Token
    const feeRate = 225 * 100
    let incentives : AltheaDexIncentivesContinuousEpochMulti
    let baseQuotePoolId: string
    let userA: SignerWithAddress
    let userB: SignerWithAddress
    let userC: SignerWithAddress

    beforeEach("deploy",  async () => {
        const signers = await ethers.getSigners();
        userA = signers[0]; // default trader
        userB = signers[2]; // other (not signers[1] which is auth)
        userC = signers[3]; // third

        [test1, test2, test3] = await makeTokenTriangle()
        baseToken = await test1.base
        quoteToken = await test1.quote
        rewardToken = await makeStandaloneToken();

        await test1.initPool(feeRate, 0, 1, 1.5)
        test1.useHotPath = true;
 
        // Note: fundTokens() is already called in makePoolFrom, which funds both trader and other
        // We just need to approve
        await test1.base.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test1.quote.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test1.base.approve(await test1.other, (await test1.dex).address, 100000000000)
        await test1.quote.approve(await test1.other, (await test1.dex).address, 100000000000)

        let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        incentives = await incentivesFactory.deploy((await test1.dex).address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;
 
        baseQuotePoolId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [baseToken.address, quoteToken.address, POOL_IDX]
            )
        );
    })

    it("two users with 60/40 split receive proportional rewards", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        // User A provides 60% of liquidity
        const liqA = 600000;
        await test1.testMint(-5000, 8000, liqA);

        // User B provides 40% of liquidity  
        const liqB = 400000;
        await test1.testMintOther(-5000, 8000, liqB);

        const userAAddress = await (await test1.trader).getAddress();
        const userBAddress = await (await test1.other).getAddress();

        // Verify userB is actually signers[1]
        expect(userBAddress).to.equal(userB.address);

        // Both register
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
        await incentives.connect(userB).register(await userB.getAddress(), baseQuotePoolId, rewardToken.address, true);

        // Wait 100 blocks
        const blocksToWait = 100;
        await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToWait.toString(16)}`]);

        // Claim rewards (each claim creates an additional block)
        const balanceA_before = await rewardToken.balanceOf(userAAddress);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balanceA_after = await rewardToken.balanceOf(userAAddress);

        const balanceB_before = await rewardToken.balanceOf(userBAddress);
        await incentives.connect(userB).claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balanceB_after = await rewardToken.balanceOf(userBAddress);

        const rewardsA = balanceA_after.sub(balanceA_before);
        const rewardsB = balanceB_after.sub(balanceB_before);

        // Both users share the same blocks
        // After 2 registrations + 100 mined + 2 claims = 104 total blocks
        // User A gets 60% of ~102 blocks (up to A's claim)
        // User B gets 40% of ~103 blocks (up to B's claim, includes A's claim block)
        expect(rewardsA).to.be.closeTo(rewardPerBlock.mul(102).mul(60).div(100), ethers.utils.parseUnits("10", 18));
        expect(rewardsB).to.be.closeTo(rewardPerBlock.mul(103).mul(40).div(100), ethers.utils.parseUnits("10", 18));

        // Total rewards distributed should be close to 103 blocks (before B's final claim block calculation)
        expect(rewardsA.add(rewardsB)).to.be.closeTo(rewardPerBlock.mul(103), ethers.utils.parseUnits("15", 18));
    });

    it("three users across multiple block periods with staggered claims", async () => {
        // This is a realistic scenario:
        // - User A: Registers early, claims after 100 blocks
        // - User B: Registers early, claims after each 50-block period
        // - User C: Registers at block 50, claims at end
        
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("20000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        // PERIOD 0 SETUP: User A and B provide liquidity (50/50 split)
        const liqA = 500000;
        const liqB = 500000;
        await test1.testMint(-5000, 8000, liqA);
        await test1.testMintOther(-5000, 8000, liqB);

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
        await incentives.connect(userB).register(await userB.getAddress(), baseQuotePoolId, rewardToken.address, true);

        // PERIOD 1: Wait 50 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(50).toString(16)}`]);

        const userAAddress = await (await test1.trader).getAddress();
        const userBAddress = await (await test1.other).getAddress();

        // User B claims after 50 blocks (should get approximately half of 50 blocks)
        const balanceB_1 = await rewardToken.balanceOf(userBAddress);
        await incentives.connect(userB).claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balanceB_2 = await rewardToken.balanceOf(userBAddress);
        const rewardsB_period1 = balanceB_2.sub(balanceB_1);

        // B gets ~50% of 52 blocks (2 registrations + 50 mined)
        expect(rewardsB_period1).to.be.closeTo(rewardPerBlock.mul(52).div(2), ethers.utils.parseUnits("5", 18));

        // PERIOD 2: Wait another 50 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(50).toString(16)}`]);

        // User B claims again (should get another ~250 from 50 blocks)
        const balanceB_3 = await rewardToken.balanceOf(userBAddress);
        await incentives.connect(userB).claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balanceB_4 = await rewardToken.balanceOf(userBAddress);
        const rewardsB_period2 = balanceB_4.sub(balanceB_3);

        // B registered then 50 blocks passed, then claimed = 51 blocks
        expect(rewardsB_period2).to.be.closeTo(rewardPerBlock.mul(51).div(2), ethers.utils.parseUnits("5", 18));

        // User A hasn't claimed yet - should have accumulated ~100+ blocks worth
        const pendingA = await incentives.getPendingRewards(userAAddress, baseQuotePoolId, rewardToken.address, true);
        // A has been accruing from registration through all blocks so far (~104 blocks)
        expect(pendingA).to.be.closeTo(rewardPerBlock.mul(104).div(2), ethers.utils.parseUnits("10", 18));

        // User A claims everything at once
        const balanceA_1 = await rewardToken.balanceOf(userAAddress);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balanceA_2 = await rewardToken.balanceOf(userAAddress);
        const rewardsA_total = balanceA_2.sub(balanceA_1);

        // A gets 50% of ~104 blocks
        expect(rewardsA_total).to.be.closeTo(rewardPerBlock.mul(104).div(2), ethers.utils.parseUnits("10", 18));

        // Verify totals are reasonable (should be close to ~104 blocks of rewards distributed)
        const totalDistributed = rewardsA_total.add(rewardsB_period1).add(rewardsB_period2);
        expect(totalDistributed).to.be.closeTo(rewardPerBlock.mul(104), ethers.utils.parseUnits("15", 18));
    });

    it("mid-block liquidity changes affect reward distribution continuously", async () => {
        // This test demonstrates how the per-block accumulator handles mid-period changes:
        // The accumulator updates at each transaction using current pool liquidity.
        // Users registered at any point accumulate rewards proportional to their share
        // of the pool from their registration block onwards.
        
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        // User A provides liquidity and registers at start
        const liqA = 500000;
        await test1.testMint(-5000, 8000, liqA);
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

        // Wait 50 blocks (halfway through our observation period)
        await hardhat.network.provider.send("hardhat_mine", [`0x${(50).toString(16)}`]);

        // User B joins and registers mid-period
        const liqB = 500000;
        await test1.testMintOther(-5000, 8000, liqB);
        await incentives.connect(userB).register(await userB.getAddress(), baseQuotePoolId, rewardToken.address, true);

        // Wait another 50 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(50).toString(16)}`]);

        const userAAddress = await (await test1.trader).getAddress();
        const userBAddress = await (await test1.other).getAddress();

        // Check pending rewards
        // Block sequence:
        // N: createProgram
        // N+1: testMint (userA)
        // N+2: register (userA)
        // N+3 to N+52: mine 50 blocks
        // N+53: testMintOther (userB)
        // N+54: register (userB)
        // N+55 to N+104: mine 50 blocks
        // getPending (view call, no new block)
        //
        // UserA: registered from N+2, alone until N+54, then shared
        // - N+2 to N+54: 52 blocks alone = 520 tokens
        // - N+54 to N+104: 50 blocks shared 50/50 = 250 tokens
        // - Total: 770 tokens
        //
        // UserB: registered from N+54
        // - N+54 to N+104: 50 blocks shared 50/50 = 250 tokens
        //
        // Total: 1020 tokens (102 blocks elapsed from userA registration)
        const pendingA = await incentives.getPendingRewards(userAAddress, baseQuotePoolId, rewardToken.address, true);
        const pendingB = await incentives.getPendingRewards(userBAddress, baseQuotePoolId, rewardToken.address, true);

        // A should have more rewards than B (had sole ownership initially)
        expect(pendingA).to.be.gt(pendingB);
        
        // B should have half of 50 blocks
        expect(pendingB).to.be.closeTo(rewardPerBlock.mul(50).div(2), ethers.utils.parseUnits("15", 18));

        // Total should be close to 102 blocks worth (accounting for timing variations)
        expect(pendingA.add(pendingB)).to.be.closeTo(rewardPerBlock.mul(102), ethers.utils.parseUnits("50", 18));

        // Claim for both
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        await incentives.connect(userB).claimRewards(baseQuotePoolId, rewardToken.address, true);

        // Re-register both for next period
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
        await incentives.connect(userB).register(await userB.getAddress(), baseQuotePoolId, rewardToken.address, true);

        // Wait another 50 blocks (now both registered for full period)
        await hardhat.network.provider.send("hardhat_mine", [`0x${50}`]);

        const pendingA_period2 = await incentives.getPendingRewards(userAAddress, baseQuotePoolId, rewardToken.address, true);
        const pendingB_period2 = await incentives.getPendingRewards(userBAddress, baseQuotePoolId, rewardToken.address, true);

        // Now 50/50 split, both should have similar rewards for this period
        expect(pendingA_period2).to.be.closeTo(pendingB_period2, ethers.utils.parseUnits("100", 18));
    });

    it("users with different liquidity amounts over multiple block periods", async () => {
        // Long-running scenario: users claim at different times over 250 blocks
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("50000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        // User A: 70% liquidity
        const liqA = 700000;
        await test1.testMint(-5000, 8000, liqA);

        // User B: 30% liquidity
        const liqB = 300000;
        await test1.testMintOther(-5000, 8000, liqB);

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
        await incentives.connect(userB).register(await userB.getAddress(), baseQuotePoolId, rewardToken.address, true);

        const userAAddress = await (await test1.trader).getAddress();
        const userBAddress = await (await test1.other).getAddress();

        let totalRewardsA = BigNumber.from(0);
        let totalRewardsB = BigNumber.from(0);

        // Periods 1-3: User A doesn't claim, User B claims after each 50-block period
        for (let i = 0; i < 3; i++) {
            await hardhat.network.provider.send("hardhat_mine", [`0x${(50).toString(16)}`]);
            
            // User B claims
            const balB_before = await rewardToken.balanceOf(userBAddress);
            await incentives.connect(userB).claimRewards(baseQuotePoolId, rewardToken.address, true);
            const balB_after = await rewardToken.balanceOf(userBAddress);
            
            const rewardsB = balB_after.sub(balB_before);
            totalRewardsB = totalRewardsB.add(rewardsB);
            
            // User B re-registers
            await incentives.connect(userB).register(await userB.getAddress(), baseQuotePoolId, rewardToken.address, true);
            
            // Each period, B should get ~30% of blocks that passed
            // First iteration: ~52 blocks (2 registrations + 50), B gets 30% = ~156
            // Later iterations: ~51 blocks (1 re-reg + 50), B gets 30% = ~153
            const expectedMin = rewardPerBlock.mul(50).mul(30).div(100);
            const expectedMax = rewardPerBlock.mul(52).mul(30).div(100);
            expect(rewardsB).to.be.gte(expectedMin);
            expect(rewardsB).to.be.lte(expectedMax.add(ethers.utils.parseUnits("5", 18)));
        }

        // After 3 periods, User A should have accumulated rewards
        // A gets 70% of the blocks that passed
        const pendingA_after3 = await incentives.getPendingRewards(userAAddress, baseQuotePoolId, rewardToken.address, true);
        expect(pendingA_after3).to.be.closeTo(rewardPerBlock.mul(154).mul(70).div(100), ethers.utils.parseUnits("30", 18));

        // User A claims after 3 periods
        const balA_before_claim = await rewardToken.balanceOf(userAAddress);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balA_after_claim = await rewardToken.balanceOf(userAAddress);
        
        const rewardsA_first = balA_after_claim.sub(balA_before_claim);
        totalRewardsA = totalRewardsA.add(rewardsA_first);
        
        // Periods 4-5: Wait 100 more blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(100).toString(16)}`]);

        // User A final claim
        const balA_before_final = await rewardToken.balanceOf(userAAddress);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balA_after_final = await rewardToken.balanceOf(userAAddress);
        const rewardsA_final = balA_after_final.sub(balA_before_final);
        totalRewardsA = totalRewardsA.add(rewardsA_final);

        // User B final claim
        const balB_before_final = await rewardToken.balanceOf(userBAddress);
        await incentives.connect(userB).claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balB_after_final = await rewardToken.balanceOf(userBAddress);
        const rewardsB_final = balB_after_final.sub(balB_before_final);
        totalRewardsB = totalRewardsB.add(rewardsB_final);

        // Verify proportions
        // A should get ~70%, B should get ~30%
        const totalDistributed = totalRewardsA.add(totalRewardsB);
        const ratioA = totalRewardsA.mul(100).div(totalDistributed);
        const ratioB = totalRewardsB.mul(100).div(totalDistributed);
        
        expect(ratioA).to.be.closeTo(BigNumber.from(70), BigNumber.from(2));
        expect(ratioB).to.be.closeTo(BigNumber.from(30), BigNumber.from(2));

        // Total should be reasonable for ~256 blocks of activity
        expect(totalDistributed).to.be.closeTo(rewardPerBlock.mul(256), ethers.utils.parseUnits("50", 18));
    });

    it("Multiple users with ambient liquidity proportional distribution", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , false);

        // User A: 75% ambient liquidity
        const liqA = 750000;
        await test1.testMintAmbient(liqA);

        // User B: 25% ambient liquidity
        const liqB = 250000;
        await test1.testMintAmbientFrom(await test1.other, liqB);

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);
        await incentives.connect(userB).register(await userB.getAddress(), baseQuotePoolId, rewardToken.address, false);

        // Wait 100 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(100).toString(16)}`]);

        const userAAddress = await (await test1.trader).getAddress();
        const userBAddress = await (await test1.other).getAddress();

        // Claim rewards (each claim creates a block)
        const balanceA_before = await rewardToken.balanceOf(userAAddress);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, false);
        const balanceA_after = await rewardToken.balanceOf(userAAddress);

        const balanceB_before = await rewardToken.balanceOf(userBAddress);
        await incentives.connect(userB).claimRewards(baseQuotePoolId, rewardToken.address, false);
        const balanceB_after = await rewardToken.balanceOf(userBAddress);

        const rewardsA = balanceA_after.sub(balanceA_before);
        const rewardsB = balanceB_after.sub(balanceB_before);

        // Both users share blocks: 2 registrations + 100 mined + claims = ~103 blocks total
        // A gets 75% of ~102 blocks (up to A's claim)
        // B gets 25% of ~103 blocks (up to B's claim)
        expect(rewardsA).to.be.closeTo(rewardPerBlock.mul(102).mul(75).div(100), ethers.utils.parseUnits("10", 18));
        expect(rewardsB).to.be.closeTo(rewardPerBlock.mul(103).mul(25).div(100), ethers.utils.parseUnits("10", 18));

        // Total should be close to ~103 blocks worth
        expect(rewardsA.add(rewardsB)).to.be.closeTo(rewardPerBlock.mul(103), ethers.utils.parseUnits("15", 18));
    });
});
