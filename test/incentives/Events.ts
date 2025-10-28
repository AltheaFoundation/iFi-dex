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

describe('Events - Per-Block Incentives', () => {
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

    it("ConcentratedProgramCreated event emitted correctly", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        const tx = await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);
        const receipt = await tx.wait();
        
        // Find the ProgramCreated event and check endBlock parameter
        const event = receipt.events?.find((e: any) => e.event === 'ProgramCreated');
        expect(event).to.not.be.undefined;
        expect(event?.args?.poolId).to.equal(baseQuotePoolId);
        expect(event?.args?.rewardToken).to.equal(rewardToken.address);
        expect(event?.args?.isConcentrated).to.equal(true);
        expect(event?.args?.rewardPerBlock).to.equal(rewardPerBlock);
        expect(event?.args?.endBlock).to.be.gt(0);
    });

    it("AmbientProgramCreated event emitted correctly", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        const tx = await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , false);
        const receipt = await tx.wait();
        
        // Find the ProgramCreated event and check endBlock parameter
        const event = receipt.events?.find((e: any) => e.event === 'ProgramCreated');
        expect(event).to.not.be.undefined;
        expect(event?.args?.poolId).to.equal(baseQuotePoolId);
        expect(event?.args?.rewardToken).to.equal(rewardToken.address);
        expect(event?.args?.isConcentrated).to.equal(false);
        expect(event?.args?.rewardPerBlock).to.equal(rewardPerBlock);
        expect(event?.args?.endBlock).to.be.gt(0);
    });

    it("ConcentratedProgramModified event emitted correctly", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        // Create first
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        const newRewardPerBlock = ethers.utils.parseUnits("20", 18);
        const newFundingAmount = ethers.utils.parseUnits("10000", 18);
        
        await rewardToken.contract.deposit(traderAddress, newFundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, newFundingAmount);

        // Modify
        const tx = await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, newRewardPerBlock, newFundingAmount
        , true);
        const receipt = await tx.wait();
        
        // Find the ProgramModified event and check parameters
        const event = receipt.events?.find((e: any) => e.event === 'ProgramModified');
        expect(event).to.not.be.undefined;
        expect(event?.args?.poolId).to.equal(baseQuotePoolId);
        expect(event?.args?.rewardToken).to.equal(rewardToken.address);
        expect(event?.args?.isConcentrated).to.equal(true);
        expect(event?.args?.newRewardPerBlock).to.equal(newRewardPerBlock);
        expect(event?.args?.newEndBlock).to.be.gt(0);
    });

    it("RegisteredForConcentratedRewards event emitted correctly", async () => {
        const liq = 1000000;
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        await expect(
            incentives.register(baseQuotePoolId, rewardToken.address, true)
        ).to.emit(incentives, "RegisteredForRewards")
            .withArgs(traderAddress, baseQuotePoolId, rewardToken.address, true);
    });

    it("RegisteredForAmbientRewards event emitted correctly", async () => {
        const liq = 1000000;
        await test1.testMintAmbient(liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , false);

        await expect(
            incentives.register(baseQuotePoolId, rewardToken.address, false)
        ).to.emit(incentives, "RegisteredForRewards")
            .withArgs(traderAddress, baseQuotePoolId, rewardToken.address, false);
    });

    it("ClaimedConcentratedRewards event emitted correctly", async () => {
        const liq = 1000000;
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const blocksToWait = 10;
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToWait.toString(16)}`]);

        // Claim transaction creates an additional block, so expect ~11 blocks worth of rewards
        const tx = await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        const receipt = await tx.wait();
        
        const event = receipt.events?.find((e: any) => e.event === 'ClaimedRewards');
        expect(event).to.not.be.undefined;
        expect(event?.args?.user).to.equal(traderAddress);
        expect(event?.args?.poolId).to.equal(baseQuotePoolId);
        expect(event?.args?.rewardToken).to.equal(rewardToken.address);
        expect(event?.args?.isConcentrated).to.equal(true);
        // Allow for timing variance - should be approximately blocksToWait + 1 blocks worth
        expect(event?.args?.amount).to.be.closeTo(
            rewardPerBlock.mul(blocksToWait + 1), 
            rewardPerBlock.mul(2) // 2 blocks tolerance
        );
    });

    it("ProgramDeactivated event emitted correctly", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        await expect(
            incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true)
        ).to.emit(incentives, "ProgramDeactivated")
            .withArgs(baseQuotePoolId, rewardToken.address, true);
    });

    it("EmergencyWithdrawal event emitted correctly", async () => {
        const fundingAmount = ethers.utils.parseUnits("1000", 18);
        const incentivesAddress = await incentives.address;
        await rewardToken.contract.deposit(incentivesAddress, fundingAmount);

        const signers = await ethers.getSigners();
        const destination = signers[0].address;
        const amount = ethers.utils.parseUnits("500", 18);

        await expect(
            incentives.emergencyWithdraw(rewardToken.address, destination, amount)
        ).to.emit(incentives, "EmergencyWithdrawal")
            .withArgs(rewardToken.address, destination, amount);
    });

    it("AccumulatorUpdated event emitted when blocks pass", async () => {
        const liq = 1000000;
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const blocksToWait = 10;
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        // Mine blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToWait.toString(16)}`]);

        // The next call should trigger an accumulator update
        const tx = await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        const receipt = await tx.wait();

        // Check that AccumulatorUpdated event was emitted
        const event = receipt.events?.find((e: any) => e.event === 'AccumulatorUpdated');
        expect(event).to.not.be.undefined;
        expect(event?.args?.poolId).to.equal(baseQuotePoolId);
        expect(event?.args?.rewardToken).to.equal(rewardToken.address);
        expect(event?.args?.isConcentrated).to.equal(true);
        // Claim transaction itself creates a block, so blocksPassed includes that block
        const actualBlocksPassed = event?.args?.blocksPassed.toNumber();
        expect(actualBlocksPassed).to.be.oneOf([blocksToWait, blocksToWait + 1]); // Allow for transaction block
    });
});
