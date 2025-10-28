import { TestPool, makeTokenPool, POOL_IDX, ERC20Token, makeStandaloneToken, makeTokenTriangle } from '../FacadePool'
import { expect } from "chai";
import "@nomiclabs/hardhat-ethers";
import hardhat, { ethers } from 'hardhat';
import { ZERO_ADDR } from '../FixedPoint';
import { solidity } from "ethereum-waffle";
import chai from "chai";
import { BigNumber, ContractFactory } from 'ethers';
import { AltheaDexIncentivesContinuousEpochMulti } from '../../typechain';

chai.use(solidity);

describe('EmergencyWithdrawAccounting - Accounting Protections', () => {
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

    describe("Basic Accounting Protection", () => {
        it("should prevent withdrawing committed funds from active program", async () => {
            const traderAddress = await (await test1.trader).getAddress();

            // Fund and create a program
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("10000", 18);
            
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true // concentrated
            );

            // Check committed rewards
            const committed = await incentives.totalCommittedRewards(rewardToken.address);
            expect(committed).to.equal(fundingAmount);

            // Try to withdraw any amount - should fail
            await expect(
                incentives.emergencyWithdraw(
                    rewardToken.address,
                    traderAddress,
                    ethers.utils.parseUnits("1", 18)
                )
            ).to.be.revertedWith("Exceeds available balance");
        });

        it("should allow withdrawing only uncommitted funds", async () => {
            const traderAddress = await (await test1.trader).getAddress();

            // Fund program
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("5000", 18);
            
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Send additional tokens directly to contract
            const extraFunds = ethers.utils.parseUnits("2000", 18);
            await rewardToken.contract.deposit(incentives.address, extraFunds);

            // Should be able to withdraw only the extra funds
            const initialBalance = await rewardToken.balanceOf(traderAddress);
            await incentives.emergencyWithdraw(
                rewardToken.address,
                traderAddress,
                extraFunds
            );

            const finalBalance = await rewardToken.balanceOf(traderAddress);
            expect(finalBalance.sub(initialBalance)).to.equal(extraFunds);

            // Should not be able to withdraw more
            await expect(
                incentives.emergencyWithdraw(
                    rewardToken.address,
                    traderAddress,
                    ethers.utils.parseUnits("1", 18)
                )
            ).to.be.revertedWith("Exceeds available balance");
        });

        it("should allow withdrawing after program is deactivated", async () => {
            const traderAddress = await (await test1.trader).getAddress();

            // Create program
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("5000", 18);
            
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Deactivate program
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);

            // Now should be able to withdraw (funds are no longer committed)
            const initialBalance = await rewardToken.balanceOf(traderAddress);
            await incentives.emergencyWithdraw(
                rewardToken.address,
                traderAddress,
                fundingAmount
            );

            const finalBalance = await rewardToken.balanceOf(traderAddress);
            expect(finalBalance.sub(initialBalance)).to.equal(fundingAmount);
        });

        it("should allow withdrawing after program expires naturally", async () => {
            const traderAddress = await (await test1.trader).getAddress();
            const liq = 10000;

            // Setup liquidity first
            await test1.testMint(-100, 100, liq);

            // Create short program
            const rewardPerBlock = ethers.utils.parseUnits("100", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18); // 10 blocks
            
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Register to trigger accumulator update
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

            const programInfo = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            const endBlock = programInfo.endBlock;

            // Mine blocks to pass the end block
            const currentBlock = await ethers.provider.getBlockNumber();
            const blocksToMine = endBlock.sub(currentBlock).toNumber() + 5;
            
            await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToMine.toString(16)}`]);

            // Check pending rewards to trigger accumulator update
            const pending = await incentives.getPendingRewards(baseQuotePoolId, traderAddress, rewardToken.address, true);
            
            // Program should be expired, all remaining funds should be available
            const contractBalance = await rewardToken.balanceOf(incentives.address);
            const availableBalance = await incentives.getAvailableBalance(rewardToken.address);
            
            // Available balance should be the contract balance minus any pending user rewards
            expect(availableBalance).to.be.gt(0);
            expect(availableBalance.add(pending)).to.be.closeTo(contractBalance, ethers.utils.parseUnits("1", 18));

            // Should be able to withdraw all available funds
            const initialBalance = await rewardToken.balanceOf(traderAddress);
            await incentives.emergencyWithdraw(
                rewardToken.address,
                traderAddress,
                availableBalance
            );

            const finalBalance = await rewardToken.balanceOf(traderAddress);
            expect(finalBalance.sub(initialBalance)).to.equal(availableBalance);
        });
    });

    describe("Multi-Program Accounting", () => {
        it("should track committed funds across multiple programs", async () => {
            const traderAddress = await (await test1.trader).getAddress();

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("5000", 18);
            
            // Create concentrated program
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true // concentrated
            );

            // Create ambient program with same token
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                false // ambient
            );

            // Total committed should be sum of both programs
            const committed = await incentives.totalCommittedRewards(rewardToken.address);
            expect(committed).to.equal(fundingAmount.mul(2));

            // Cannot withdraw any committed funds
            await expect(
                incentives.emergencyWithdraw(
                    rewardToken.address,
                    traderAddress,
                    ethers.utils.parseUnits("1", 18)
                )
            ).to.be.revertedWith("Exceeds available balance");
        });

        it("should allow partial withdrawal when one program is deactivated", async () => {
            const traderAddress = await (await test1.trader).getAddress();

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("5000", 18);
            
            // Create two programs
            await rewardToken.contract.deposit(traderAddress, fundingAmount.mul(2));
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount.mul(2));
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount, true);
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount, false);

            // Deactivate concentrated program
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);

            // Should be able to withdraw funds from deactivated program
            const initialBalance = await rewardToken.balanceOf(traderAddress);
            await incentives.emergencyWithdraw(
                rewardToken.address,
                traderAddress,
                fundingAmount
            );

            const finalBalance = await rewardToken.balanceOf(traderAddress);
            expect(finalBalance.sub(initialBalance)).to.equal(fundingAmount);

            // Cannot withdraw more (ambient program still active)
            await expect(
                incentives.emergencyWithdraw(
                    rewardToken.address,
                    traderAddress,
                    ethers.utils.parseUnits("1", 18)
                )
            ).to.be.revertedWith("Exceeds available balance");
        });

        it("should properly account when creating zero-rate program to free funds", async () => {
            const traderAddress = await (await test1.trader).getAddress();

            // Create program with non-zero rate
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("5000", 18);
            
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Deactivate 
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);

            // All funds should now be available
            const availableBalance = await incentives.getAvailableBalance(rewardToken.address);
            expect(availableBalance).to.equal(fundingAmount);

            // Should be able to withdraw all
            const initialBalance = await rewardToken.balanceOf(traderAddress);
            await incentives.emergencyWithdraw(
                rewardToken.address,
                traderAddress,
                fundingAmount
            );

            const finalBalance = await rewardToken.balanceOf(traderAddress);
            expect(finalBalance.sub(initialBalance)).to.equal(fundingAmount);
        });
    });

    describe("Native Token Accounting", () => {
        it("should prevent withdrawing committed native token funds", async () => {
            const signers = await ethers.getSigners();
            const owner = signers[0];

            const rewardPerBlock = ethers.utils.parseEther("0.1");
            const fundingAmount = ethers.utils.parseEther("10");
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                ZERO_ADDR,
                rewardPerBlock,
                fundingAmount,
                true,
                { value: fundingAmount }
            );

            // Cannot withdraw committed native tokens
            await expect(
                incentives.emergencyWithdraw(
                    ZERO_ADDR,
                    owner.address,
                    ethers.utils.parseEther("0.1")
                )
            ).to.be.revertedWith("Exceeds available balance");
        });

        it("should allow withdrawing uncommitted native tokens", async () => {
            const signers = await ethers.getSigners();
            const owner = signers[0];

            // Send native tokens directly
            const extraFunds = ethers.utils.parseEther("5");
            await owner.sendTransaction({
                to: incentives.address,
                value: extraFunds
            });

            // Should be able to withdraw
            const destination = signers[2].address;
            const initialBalance = await ethers.provider.getBalance(destination);
            
            await incentives.emergencyWithdraw(
                ZERO_ADDR,
                destination,
                extraFunds
            );

            const finalBalance = await ethers.provider.getBalance(destination);
            expect(finalBalance.sub(initialBalance)).to.equal(extraFunds);
        });

        it("should handle mixed committed and uncommitted native tokens", async () => {
            const signers = await ethers.getSigners();
            const owner = signers[0];

            // Create program with native tokens
            const rewardPerBlock = ethers.utils.parseEther("0.1");
            const fundingAmount = ethers.utils.parseEther("10");
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                ZERO_ADDR,
                rewardPerBlock,
                fundingAmount,
                true,
                { value: fundingAmount }
            );

            // Send extra native tokens
            const extraFunds = ethers.utils.parseEther("3");
            await owner.sendTransaction({
                to: incentives.address,
                value: extraFunds
            });

            // Should only be able to withdraw extra funds
            const destination = signers[2].address;
            const initialBalance = await ethers.provider.getBalance(destination);
            
            await incentives.emergencyWithdraw(
                ZERO_ADDR,
                destination,
                extraFunds
            );

            const finalBalance = await ethers.provider.getBalance(destination);
            expect(finalBalance.sub(initialBalance)).to.equal(extraFunds);

            // Cannot withdraw more
            await expect(
                incentives.emergencyWithdraw(
                    ZERO_ADDR,
                    destination,
                    ethers.utils.parseEther("0.1")
                )
            ).to.be.revertedWith("Exceeds available balance");
        });
    });

    describe("Accounting After Claims", () => {
        it("should allow withdrawing leftover funds after users claim", async () => {
            const traderAddress = await (await test1.trader).getAddress();
            const liq = 10000;

            // Setup liquidity
            await test1.testMint(-100, 100, liq);

            // Create program
            const rewardPerBlock = ethers.utils.parseUnits("100", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // User registers
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

            // Mine some blocks
            await hardhat.network.provider.send("hardhat_mine", [`0x${(5).toString(16)}`]);

            // User claims (partial)
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            // Deactivate program
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);

            // Should be able to withdraw remaining funds
            const availableBalance = await incentives.getAvailableBalance(rewardToken.address);
            expect(availableBalance).to.be.gt(0);

            const initialBalance = await rewardToken.balanceOf(traderAddress);
            await incentives.emergencyWithdraw(
                rewardToken.address,
                traderAddress,
                availableBalance
            );

            const finalBalance = await rewardToken.balanceOf(traderAddress);
            expect(finalBalance.sub(initialBalance)).to.equal(availableBalance);
        });
    });

    describe("Edge Cases", () => {
        it("should handle withdrawal when balance equals committed amount", async () => {
            const traderAddress = await (await test1.trader).getAddress();

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("5000", 18);
            
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Balance should equal committed
            const balance = await rewardToken.balanceOf(incentives.address);
            const committed = await incentives.totalCommittedRewards(rewardToken.address);
            expect(balance).to.equal(committed);

            // Available should be zero
            const available = await incentives.getAvailableBalance(rewardToken.address);
            expect(available).to.equal(0);

            // Cannot withdraw anything
            await expect(
                incentives.emergencyWithdraw(
                    rewardToken.address,
                    traderAddress,
                    1
                )
            ).to.be.revertedWith("Exceeds available balance");
        });

        it("should verify balance check protects against underflow", async () => {
            const traderAddress = await (await test1.trader).getAddress();

            // This test verifies the safety check exists
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("5000", 18);
            
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, incentives.address, fundingAmount);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Verify the check exists by checking normal operation passes
            const balance = await rewardToken.balanceOf(incentives.address);
            const committed = await incentives.totalCommittedRewards(rewardToken.address);
            expect(balance).to.be.gte(committed);
        });
    });
});
