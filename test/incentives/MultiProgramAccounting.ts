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

chai.use(solidity);

describe('MultiProgramAccounting - Per-Block Incentives', () => {
    let test1: TestPool
    let test2: TestPool
    let test3: TestPool
    let baseToken: ERC20Token
    let quoteToken: ERC20Token
    let rewardToken: ERC20Token
    const feeRate = 225 * 100
    let incentives : AltheaDexIncentivesContinuousEpochMulti
    let pool1Id: string
    let pool2Id: string

    beforeEach("deploy",  async () => {
        [test1, test2, test3] = await makeTokenTriangle()
        baseToken = await test1.base
        quoteToken = await test1.quote
        rewardToken = await makeStandaloneToken();

        await test1.initPool(feeRate, 0, 1, 1.5)
        await test2.initPool(feeRate, 0, 1, 1.5)
        test1.useHotPath = true;
        test2.useHotPath = true;
 
        await test1.base.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test1.quote.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test2.base.approve(await test1.trader, (await test2.dex).address, 100000000000)
        await test2.quote.approve(await test1.trader, (await test2.dex).address, 100000000000)

        let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        incentives = await incentivesFactory.deploy((await test1.dex).address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;
 
        pool1Id = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [baseToken.address, quoteToken.address, POOL_IDX]
            )
        );

        pool2Id = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [test2.base.address, test2.quote.address, POOL_IDX]
            )
        );
    })

    describe("Multiple Concentrated Programs Same Token", () => {
        it("two concentrated programs with same reward token track commitments correctly", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const totalFunding = ethers.utils.parseUnits("2000", 18); // 200 blocks total
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, totalFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, totalFunding);
            
            // Create first program (should take 100 blocks worth = 1000 tokens)
            await incentives.createOrModifyProgram(pool1Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), true);
            
            const program1 = await incentives.getConcentratedProgramInfo(pool1Id, rewardToken.address);
            const committed1 = await incentives.totalCommittedRewards(rewardToken.address);
            
            expect(committed1).to.equal(ethers.utils.parseUnits("1000", 18)); // 100 blocks
            
            // Create second program (should also take 100 blocks worth = 1000 tokens)
            await incentives.createOrModifyProgram(pool2Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), true);
            
            const program2 = await incentives.getConcentratedProgramInfo(pool2Id, rewardToken.address);
            const committed2 = await incentives.totalCommittedRewards(rewardToken.address);
            
            expect(committed2).to.equal(ethers.utils.parseUnits("2000", 18)); // 200 blocks total
            
            // Verify both programs are active
            expect(program1.active).to.be.true;
            expect(program2.active).to.be.true;
        });

        it("programs operate independently with same reward token", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            await test2.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const totalFunding = ethers.utils.parseUnits("2000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, totalFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, totalFunding);
            
            await incentives.createOrModifyProgram(pool1Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), true);
            
            await incentives.createOrModifyProgram(pool2Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), true);
            
            // Register for both
            await incentives.register(pool1Id, rewardToken.address, true);
            await incentives.register(pool2Id, rewardToken.address, true);
            
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);
            
            const trader = await (await test1.trader).getAddress();
            const initialBalance = await rewardToken.balanceOf(trader);
            
            // Claim from pool1
            await incentives.claimRewards(pool1Id, rewardToken.address, true);
            
            const balanceAfterPool1 = await rewardToken.balanceOf(trader);
            expect(balanceAfterPool1.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 18));
            
            // Claim from pool2
            await incentives.claimRewards(pool2Id, rewardToken.address, true);
            
            const finalBalance = await rewardToken.balanceOf(trader);
            expect(finalBalance.sub(balanceAfterPool1)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 18));
            
            // Total should be approximately 2 * rewardPerBlock * 10
            expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(20), ethers.utils.parseUnits("40", 18));
        });

        it("modifying one program doesn't affect commitments of another", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const totalFunding = ethers.utils.parseUnits("3000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, totalFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, totalFunding);
            
            await incentives.createOrModifyProgram(pool1Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), true);
            
            await incentives.createOrModifyProgram(pool2Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), true);
            
            const committedBefore = await incentives.totalCommittedRewards(rewardToken.address);
            expect(committedBefore).to.equal(ethers.utils.parseUnits("2000", 18));
            
            // Modify pool1 to increase reward per block
            const newRewardPerBlock = ethers.utils.parseUnits("20", 18);
            await incentives.createOrModifyProgram(pool1Id, rewardToken.address, newRewardPerBlock, ethers.utils.parseUnits("1000", 18), true);
            
            // Total committed should now be: pool1 (50 blocks * 20 = 1000) + pool2 (100 blocks * 10 = 1000) = 2000
            // But we funded with 3000 total, so the total committed is 3000 (pool1 gets 50 blocks, pool2 still has 100)
            const committedAfter = await incentives.totalCommittedRewards(rewardToken.address);
            expect(committedAfter).to.equal(ethers.utils.parseUnits("3000", 18));
            
            // Pool2 should be unaffected
            const program2 = await incentives.getConcentratedProgramInfo(pool2Id, rewardToken.address);
            expect(program2.rewardPerBlock).to.equal(rewardPerBlock);
        });
    });

    describe("Multiple Ambient Programs Same Token", () => {
        it("two ambient programs with same reward token work independently", async () => {
            const signers = await ethers.getSigners();
            const userB = signers[2];
            
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            // Approve tokens for userB
            await test1.base.approve(userB, (await test1.dex).address, 100000000000);
            await test1.quote.approve(userB, (await test1.dex).address, 100000000000);
            
            await test1.testMintAmbientFrom(userB, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const totalFunding = ethers.utils.parseUnits("2000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, totalFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, totalFunding);
            
            await incentives.createOrModifyProgram(pool1Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), false);
            
            await incentives.createOrModifyProgram(pool2Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), false);
            
            await incentives.register(pool1Id, rewardToken.address, false);
            await incentives.connect(userB).register(pool1Id, rewardToken.address, false);
            
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);
            
            const trader = await (await test1.trader).getAddress();
            const initialBalance = await rewardToken.balanceOf(trader);
            const initialBalanceB = await rewardToken.balanceOf(userB.address);
            
            await incentives.claimRewards(pool1Id, rewardToken.address, false);
            await incentives.connect(userB).claimRewards(pool1Id, rewardToken.address, false);
            
            const finalBalance = await rewardToken.balanceOf(trader);
            const finalBalanceB = await rewardToken.balanceOf(userB.address);
            
            // Block sequence similar to other tests:
            // Users register sequentially (2 blocks), mine 10 blocks, then claim sequentially (2 blocks)
            // First user gets: 1 block alone + 11 blocks at 50% = 10 + 55 = 65 tokens
            // Second user gets: 11 blocks at 50% + 1 block alone = 55 + 10 = 65 tokens
            expect(finalBalance.sub(initialBalance)).to.be.closeTo(
                ethers.utils.parseUnits("65", 18),
                ethers.utils.parseUnits("10", 18)
            );
            expect(finalBalanceB.sub(initialBalanceB)).to.be.closeTo(
                ethers.utils.parseUnits("65", 18),
                ethers.utils.parseUnits("10", 18)
            );
        });
    });

    describe("Mixed Concentrated and Ambient Programs", () => {
        it("concentrated and ambient programs with same reward token work independently", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq); // Concentrated in pool1
            await test2.testMintAmbientFrom(await test1.trader, liq); // Ambient in pool2
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const totalFunding = ethers.utils.parseUnits("2000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, totalFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, totalFunding);
            
            await incentives.createOrModifyProgram(pool1Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), true);
            
            await incentives.createOrModifyProgram(pool2Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), false);
            
            await incentives.register(pool1Id, rewardToken.address, true);
            await incentives.register(pool2Id, rewardToken.address, false);
            
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);
            
            const trader = await (await test1.trader).getAddress();
            const initialBalance = await rewardToken.balanceOf(trader);
            
            await incentives.claimRewards(pool1Id, rewardToken.address, true);
            await incentives.claimRewards(pool2Id, rewardToken.address, false);
            
            const finalBalance = await rewardToken.balanceOf(trader);
            expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(20), ethers.utils.parseUnits("40", 18));
        });
    });

    describe("Same Pool Multiple Reward Tokens", () => {
        it("concentrated: same pool can have multiple different reward tokens", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardToken2 = await makeStandaloneToken();
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const funding = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, funding);
            await rewardToken2.contract.deposit(traderAddress, funding);
            await rewardToken.approve(await test1.trader, await incentives.address, funding);
            await rewardToken2.approve(await test1.trader, await incentives.address, funding);
            
            // Create two programs for same pool with different reward tokens
            await incentives.createOrModifyProgram(pool1Id, rewardToken.address, rewardPerBlock, funding
            , true);
            
            await incentives.createOrModifyProgram(pool1Id, rewardToken2.address, rewardPerBlock, funding
            , true);
            
            // Register for both
            await incentives.register(pool1Id, rewardToken.address, true);
            await incentives.register(pool1Id, rewardToken2.address, true);
            
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);
            
            const trader = await (await test1.trader).getAddress();
            
            const initialBalance1 = await rewardToken.balanceOf(trader);
            await incentives.claimRewards(pool1Id, rewardToken.address, true);
            const finalBalance1 = await rewardToken.balanceOf(trader);
            
            const initialBalance2 = await rewardToken2.balanceOf(trader);
            await incentives.claimRewards(pool1Id, rewardToken2.address, true);
            const finalBalance2 = await rewardToken2.balanceOf(trader);
            
            expect(finalBalance1.sub(initialBalance1)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 18));
            expect(finalBalance2.sub(initialBalance2)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 18));
        });

        it("ambient: same pool can have multiple different reward tokens", async () => {
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            const rewardToken2 = await makeStandaloneToken();
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const funding = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, funding);
            await rewardToken2.contract.deposit(traderAddress, funding);
            await rewardToken.approve(await test1.trader, await incentives.address, funding);
            await rewardToken2.approve(await test1.trader, await incentives.address, funding);
            
            await incentives.createOrModifyProgram(pool1Id, rewardToken.address, rewardPerBlock, funding
            , false);
            
            await incentives.createOrModifyProgram(pool1Id, rewardToken2.address, rewardPerBlock, funding
            , false);
            
            await incentives.register(pool1Id, rewardToken.address, false);
            await incentives.register(pool1Id, rewardToken2.address, false);
            
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);
            
            const trader = await (await test1.trader).getAddress();
            
            const initialBalance1 = await rewardToken.balanceOf(trader);
            await incentives.claimRewards(pool1Id, rewardToken.address, false);
            const finalBalance1 = await rewardToken.balanceOf(trader);
            
            const initialBalance2 = await rewardToken2.balanceOf(trader);
            await incentives.claimRewards(pool1Id, rewardToken2.address, false);
            const finalBalance2 = await rewardToken2.balanceOf(trader);
            
            expect(finalBalance1.sub(initialBalance1)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 18));
            expect(finalBalance2.sub(initialBalance2)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 18));
        });
    });

    describe("Funding Exhaustion with Multiple Programs", () => {
        it("one program exhausting doesn't affect other programs", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            await test2.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            const totalFunding = ethers.utils.parseUnits("1100", 18);
            await rewardToken.contract.deposit(traderAddress, totalFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, totalFunding);
            
            // Fund pool1 for only 10 blocks
            await incentives.createOrModifyProgram(pool1Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("100", 18), true);
            
            // Fund pool2 for 100 blocks
            await incentives.createOrModifyProgram(pool2Id, rewardToken.address, rewardPerBlock, ethers.utils.parseUnits("1000", 18), true);
            
            await incentives.register(pool1Id, rewardToken.address, true);
            await incentives.register(pool2Id, rewardToken.address, true);
            
            // Wait for 20 blocks (pool1 should exhaust after 10)
            await hardhat.network.provider.send("hardhat_mine", [`0x${(20).toString(16)}`]);
            
            // Trigger update for pool1
            await incentives.claimRewards(pool1Id, rewardToken.address, true);
            
            const program1 = await incentives.getConcentratedProgramInfo(pool1Id, rewardToken.address);
            const currentBlock = await ethers.provider.getBlockNumber();
            expect(currentBlock).to.be.gte(program1.endBlock); // Verify funding is exhausted
            
            // Pool2 should still be active
            const isPool2Active = await incentives.isConcentratedProgramActive(pool2Id, rewardToken.address);
            expect(isPool2Active).to.be.true;
            
            // Can still claim from pool2
            const trader = await (await test1.trader).getAddress();
            const initialBalance = await rewardToken.balanceOf(trader);
            
            await incentives.claimRewards(pool2Id, rewardToken.address, true);
            
            const finalBalance = await rewardToken.balanceOf(trader);
            expect(finalBalance.sub(initialBalance)).to.be.gt(0);
        });
    });
});
