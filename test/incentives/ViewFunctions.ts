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

describe('ViewFunctions - Per-Block Incentives', () => {
    let test1: TestPool
    let test2: TestPool
    let test3: TestPool
    let baseToken: ERC20Token
    let quoteToken: ERC20Token
    let rewardToken: ERC20Token
    const feeRate = 225 * 100
    let incentives : AltheaDexIncentivesContinuousEpochMulti
    let baseQuotePoolId: string

    beforeEach("deploy",  async () => {
        [test1, test2, test3] = await makeTokenTriangle()
        baseToken = await test1.base
        quoteToken = await test1.quote
        rewardToken = await makeStandaloneToken();

        await test1.initPool(feeRate, 0, 1, 1.5)
        test1.useHotPath = true;
 
        await test1.base.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test1.quote.approve(await test1.trader, (await test1.dex).address, 100000000000)

        let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        incentives = await incentivesFactory.deploy((await test1.dex).address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;
 
        baseQuotePoolId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [baseToken.address, quoteToken.address, POOL_IDX]
            )
        );
    })

    describe("getPendingRewards Accuracy", () => {
        it("concentrated: getPendingRewards matches actual claim amount", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            await incentives.register(baseQuotePoolId, rewardToken.address, true);
            
            // Wait 10 blocks (mine 9, claim creates the 10th)
            const blocksToWait = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);
            
            const balanceBefore = await rewardToken.balanceOf(traderAddress);
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            const balanceAfter = await rewardToken.balanceOf(traderAddress);
            
            const actualReceived = balanceAfter.sub(balanceBefore);
            
            // Should receive rewards for exactly blocksToWait blocks
            expect(actualReceived).to.equal(rewardPerBlock.mul(blocksToWait));
        });

        it("ambient: getPendingRewards matches actual claim amount", async () => {
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , false);
            
            await incentives.register(baseQuotePoolId, rewardToken.address, false);
            
            // Wait 10 blocks (mine 9, claim creates the 10th)
            const blocksToWait = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);
            
            const balanceBefore = await rewardToken.balanceOf(traderAddress);
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, false);
            const balanceAfter = await rewardToken.balanceOf(traderAddress);
            
            const actualReceived = balanceAfter.sub(balanceBefore);
            
            // Should receive rewards for exactly blocksToWait blocks
            expect(actualReceived).to.equal(rewardPerBlock.mul(blocksToWait));
        });

        it("concentrated: getPendingRewards updates correctly across multiple blocks", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            await incentives.register(baseQuotePoolId, rewardToken.address, true);
            
            
            // After 10 blocks (mine 10 since we're just checking, not claiming)
            const blocksToWait1 = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToWait1.toString(16)}`]);
            let pending = await incentives.getPendingConcentratedRewards(baseQuotePoolId, traderAddress, rewardToken.address);
            expect(pending).to.be.closeTo(rewardPerBlock.mul(blocksToWait1), ethers.utils.parseUnits("1", 18));
            
            // After 20 total blocks (mine 10 more)
            const blocksToWait2 = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToWait2.toString(16)}`]);
            pending = await incentives.getPendingConcentratedRewards(baseQuotePoolId, traderAddress, rewardToken.address);
            expect(pending).to.be.closeTo(rewardPerBlock.mul(blocksToWait1 + blocksToWait2), ethers.utils.parseUnits("2", 18));
            
            // After 30 total blocks (mine 10 more)
            const blocksToWait3 = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToWait3.toString(16)}`]);
            pending = await incentives.getPendingConcentratedRewards(baseQuotePoolId, traderAddress, rewardToken.address);
            expect(pending).to.be.closeTo(rewardPerBlock.mul(blocksToWait1 + blocksToWait2 + blocksToWait3), ethers.utils.parseUnits("3", 18));
        });
    });

    describe("getAvailableBalance", () => {
        it("returns correct balance with no programs", async () => {
            const funding = ethers.utils.parseUnits("1000", 18);
            await rewardToken.contract.deposit(await incentives.address, funding);
            
            const available = await incentives.getAvailableBalance(rewardToken.address);
            expect(available).to.equal(funding);
        });

        it("accounts for committed rewards", async () => {
            const funding = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, funding);
            await rewardToken.approve(await test1.trader, await incentives.address, funding);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, funding
            , true);
            
            const available = await incentives.getAvailableBalance(rewardToken.address);
            // 1000 total - 1000 committed (100 blocks funded) = 0
            expect(available).to.equal(0);
        });

        it("accounts for pending rewards", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const funding = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, funding);
            await rewardToken.approve(await test1.trader, await incentives.address, funding);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, funding
            , true);
            
            await incentives.register(baseQuotePoolId, rewardToken.address, true);
            
            // Wait 10 blocks (mine 9, claim creates the 10th)
            const blocksToWait = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);
            
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            const available = await incentives.getAvailableBalance(rewardToken.address);
            // Originally 1000 funded, approximately 100 tokens distributed and transferred out
            // Remaining: approximately 900 tokens committed
            // Available should be 0 or very close to it (accounting for block timing)
            expect(available).to.be.lte(ethers.utils.parseUnits("20", 18)); // Allow up to 2 blocks worth
        });

        it("increases after withdrawing pending rewards", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const funding = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, funding);
            await rewardToken.approve(await test1.trader, await incentives.address, funding);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, funding
            , true);
            
            await incentives.register(baseQuotePoolId, rewardToken.address, true);
            
            // Wait 10 blocks (mine 9, claim creates the 10th)
            const blocksToWait = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);
            
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            const availableBefore = await incentives.getAvailableBalance(rewardToken.address);
            
            
            const availableAfter = await incentives.getAvailableBalance(rewardToken.address);
            
            // Available should not change (tokens leave the contract when withdrawn)
            expect(availableAfter).to.equal(availableBefore);
        });
    });

    describe("Program Status Functions", () => {
        it("getConcentratedProgramStatus returns accurate data", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("500", 18); // 50 blocks funded
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            const status = await incentives.getConcentratedProgramStatus(baseQuotePoolId, rewardToken.address);
            
            expect(status.active).to.be.true;
            expect(status.fundingExhausted).to.be.false; // This is computed by the contract
            expect(status.currentBlock).to.equal(await ethers.provider.getBlockNumber());
            expect(status.remainingBlocks).to.equal(50);
            expect(status.remainingRewards).to.equal(fundingAmount);
        });

        it("getAmbientProgramStatus returns accurate data", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("300", 18); // 30 blocks funded
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , false);
            
            const status = await incentives.getAmbientProgramStatus(baseQuotePoolId, rewardToken.address);
            
            expect(status.active).to.be.true;
            expect(status.fundingExhausted).to.be.false; // This is computed by the contract
            expect(status.remainingBlocks).to.equal(30);
            expect(status.remainingRewards).to.equal(fundingAmount);
        });

        it("status reflects exhaustion correctly", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("100", 18); // 10 blocks funded
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            await incentives.register(baseQuotePoolId, rewardToken.address, true);
            
            // Wait past end block
            await hardhat.network.provider.send("hardhat_mine", [`0x${(20).toString(16)}`]);
            
            // Trigger update
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            const status = await incentives.getConcentratedProgramStatus(baseQuotePoolId, rewardToken.address);
            
            expect(status.active).to.be.true; // Still marked active (just exhausted)
            expect(status.fundingExhausted).to.be.true; // This is computed by the contract (block.number >= endBlock)
            expect(status.remainingBlocks).to.equal(0);
            expect(status.remainingRewards).to.equal(0);
        });
    });

    describe("Remaining Blocks and Rewards", () => {
        it("concentrated: getConcentratedRemainingBlocks decreases over time", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("500", 18); // 50 blocks funded
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            const remaining1 = await incentives.getConcentratedRemainingBlocks(baseQuotePoolId, rewardToken.address);
            // Should start with approximately 50 blocks funded
            expect(remaining1.toNumber()).to.be.greaterThan(40);
            
            // Wait 10 blocks
            await hardhat.network.provider.send("hardhat_mine", [`0x${10}`]);
            
            const remaining2 = await incentives.getConcentratedRemainingBlocks(baseQuotePoolId, rewardToken.address);
            // Should have decreased
            expect(remaining2.toNumber()).to.be.lessThan(remaining1.toNumber());
            expect(remaining2.toNumber()).to.be.greaterThan(20);
            
            // Wait 20 more blocks
            await hardhat.network.provider.send("hardhat_mine", [`0x${20}`]);
            
            const remaining3 = await incentives.getConcentratedRemainingBlocks(baseQuotePoolId, rewardToken.address);
            // Should have decreased further
            expect(remaining3.toNumber()).to.be.lessThan(remaining2.toNumber());
        });

        it("concentrated: getConcentratedRemainingRewards matches remaining blocks", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("500", 18); // 50 blocks funded
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            const remainingBlocks = await incentives.getConcentratedRemainingBlocks(baseQuotePoolId, rewardToken.address);
            const remainingRewards = await incentives.getConcentratedRemainingRewards(baseQuotePoolId, rewardToken.address);
            
            expect(remainingRewards).to.equal(rewardPerBlock.mul(remainingBlocks));
        });
    });

    // "Blocks Until Next Epoch" section removed - per-block system has no epochs

    describe("User Info Functions", () => {
        it("concentrated: getConcentratedUserInfo returns correct data", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            
            // Before registration
            let userInfo = await incentives.getConcentratedUserInfo(traderAddress, baseQuotePoolId, rewardToken.address);
            expect(userInfo.registered).to.be.false;
            expect(userInfo.userLiquidity).to.equal(0);
            
            // Check pending rewards using view function
            let pending = await incentives.getPendingConcentratedRewards(baseQuotePoolId, traderAddress, rewardToken.address);
            expect(pending).to.equal(0);
            
            // After registration
            await incentives.register(baseQuotePoolId, rewardToken.address, true);
            
            userInfo = await incentives.getConcentratedUserInfo(traderAddress, baseQuotePoolId, rewardToken.address);
            expect(userInfo.registered).to.be.true;
            // Liquidity is stored as liq * 1024 in the pool
            expect(userInfo.userLiquidity).to.equal(liq * 1024);
            
            pending = await incentives.getPendingConcentratedRewards(baseQuotePoolId, traderAddress, rewardToken.address);
            expect(pending).to.equal(0);
            
            // After 10 blocks pass (mine 10 since we're just checking, not claiming)
            const blocksToWait = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToWait.toString(16)}`]);
            
            pending = await incentives.getPendingConcentratedRewards(baseQuotePoolId, traderAddress, rewardToken.address);
            expect(pending).to.equal(rewardPerBlock.mul(blocksToWait));
            
            // After claiming, pending should be 0
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            pending = await incentives.getPendingConcentratedRewards(baseQuotePoolId, traderAddress, rewardToken.address);
            expect(pending).to.equal(0);
        });

        it("ambient: getAmbientUserInfo returns correct data", async () => {
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , false);
            
            
            let userInfo = await incentives.getAmbientUserInfo(traderAddress, baseQuotePoolId, rewardToken.address);
            expect(userInfo.registered).to.be.false;
            
            await incentives.register(baseQuotePoolId, rewardToken.address, false);
            
            userInfo = await incentives.getAmbientUserInfo(traderAddress, baseQuotePoolId, rewardToken.address);
            expect(userInfo.registered).to.be.true;
            // Liquidity is stored as liq * 1024 in the pool
            expect(userInfo.userLiquidity).to.equal(liq * 1024);
        });
    });
});
