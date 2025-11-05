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

describe('NeedsReregistration - Per-Block Incentives', () => {
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

    describe("Concentrated Liquidity", () => {
        it("returns false when program doesn't exist", async () => {
            const traderAddress = await (await test1.trader).getAddress();
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(needs).to.be.false;
        });

        it("returns false when program is inactive (funding exhausted)", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("100", 18); // 10 blocks
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            // Mine past the end block
            await hardhat.network.provider.send("hardhat_mine", [`0x${(20).toString(16)}`]);
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(needs).to.be.false;
        });

        it("returns true when user is not registered", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(needs).to.be.true;
        });

        it("returns false when user is properly registered with unchanged liquidity", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(needs).to.be.false;
        });

        it("returns true when user's liquidity has increased", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Add more liquidity
            await test1.testMint(-5000, 8000, liq);
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(needs).to.be.true;
        });

        it("returns true when user's liquidity has decreased", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Remove some liquidity
            await test1.testBurn(-5000, 8000, liq / 2);
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(needs).to.be.true;
        });

        it("returns true when user is registered in old epoch", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount.mul(2));
            
            // Create program and register
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Deactivate and reactivate program (increments epoch)
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(needs).to.be.true;
        });

        it("returns false after re-registering in new epoch", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount.mul(2));
            
            // Create program and register
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Deactivate and reactivate program (increments epoch)
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            // Re-register for new epoch
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(needs).to.be.false;
        });

        it("returns false even after claiming rewards (no re-registration needed)", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Wait and claim
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(needs).to.be.false;
        });
    });

    describe("Ambient Liquidity", () => {
        it("returns false when program doesn't exist", async () => {
            const traderAddress = await (await test1.trader).getAddress();
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                false
            );
            
            expect(needs).to.be.false;
        });

        it("returns true when user is not registered", async () => {
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                false
            );
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                false
            );
            
            expect(needs).to.be.true;
        });

        it("returns false when user is properly registered", async () => {
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                false
            );
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                false
            );
            
            expect(needs).to.be.false;
        });

        it("returns true when user's liquidity has changed", async () => {
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                false
            );
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);
            
            // Remove some ambient liquidity to change the position
            await test1.testBurnAmbient(liq / 2);
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                false
            );
            
            expect(needs).to.be.true;
        });

        it("returns true when user is registered in old epoch", async () => {
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount.mul(2));
            
            // Create program and register
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                false
            );
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);
            
            // Deactivate and reactivate program (increments epoch)
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, false);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                false
            );
            
            const needs = await incentives.needsReregistration(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                false
            );
            
            expect(needs).to.be.true;
        });
    });

    describe("Edge Cases", () => {
        it("handles zero address user", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            // Should return false (no program participation) or true (needs to register)
            // Since address(0) won't have liquidity, it will need to register
            const needs = await incentives.needsReregistration(
                ZERO_ADDR,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            // Zero address has no liquidity, so needs registration returns true
            expect(needs).to.be.true;
        });

        it("handles multiple sequential re-registrations", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            // Initial registration
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            expect(await incentives.needsReregistration(traderAddress, baseQuotePoolId, rewardToken.address, true)).to.be.false;
            
            // Add liquidity -> needs re-registration
            await test1.testMint(-5000, 8000, liq);
            expect(await incentives.needsReregistration(traderAddress, baseQuotePoolId, rewardToken.address, true)).to.be.true;
            
            // Re-register
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            expect(await incentives.needsReregistration(traderAddress, baseQuotePoolId, rewardToken.address, true)).to.be.false;
            
            // Remove liquidity -> needs re-registration
            await test1.testBurn(-5000, 8000, liq);
            expect(await incentives.needsReregistration(traderAddress, baseQuotePoolId, rewardToken.address, true)).to.be.true;
            
            // Re-register again
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            expect(await incentives.needsReregistration(traderAddress, baseQuotePoolId, rewardToken.address, true)).to.be.false;
        });
    });
});
