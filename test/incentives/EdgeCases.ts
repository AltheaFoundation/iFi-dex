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

describe('EdgeCases - Per-Block Incentives', () => {
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

    describe("Constructor Validation", () => {
        it("reverts with zero DEX address", async () => {
            let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
            
            await expect(
                incentivesFactory.deploy(ZERO_ADDR, ZERO_ADDR)
            ).to.be.revertedWith("Invalid DEX address");
        });

        it("sets owner correctly when specified", async () => {
            const signers = await ethers.getSigners();
            const customOwner = signers[1];
            
            let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
            const newIncentives = await incentivesFactory.deploy((await test1.dex).address, customOwner.address) as AltheaDexIncentivesContinuousEpochMulti;
            
            expect(await newIncentives.owner()).to.equal(customOwner.address);
        });

        it("defaults to msg.sender when owner is zero address", async () => {
            const signers = await ethers.getSigners();
            const deployer = signers[0];
            
            let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
            const newIncentives = await incentivesFactory.deploy((await test1.dex).address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;
            
            expect(await newIncentives.owner()).to.equal(deployer.address);
        });
    });

    describe("Emergency Withdraw Edge Cases", () => {
        it("reverts when withdrawing zero amount", async () => {
            const signers = await ethers.getSigners();
            const owner = signers[0];
            
            await expect(
                incentives.emergencyWithdraw(rewardToken.address, owner.address, 0)
            ).to.be.revertedWith("Zero amount");
        });

        it("reverts when destination is zero address", async () => {
            await rewardToken.contract.deposit(await incentives.address, ethers.utils.parseUnits("100", 18));
            
            await expect(
                incentives.emergencyWithdraw(rewardToken.address, ZERO_ADDR, ethers.utils.parseUnits("50", 18))
            ).to.be.revertedWith("Zero destination");
        });

        it("can withdraw exact contract balance", async () => {
            const signers = await ethers.getSigners();
            const owner = signers[0];
            const amount = ethers.utils.parseUnits("100", 18);
            
            await rewardToken.contract.deposit(await incentives.address, amount);
            
            const initialBalance = await rewardToken.balanceOf(owner.address);
            await incentives.emergencyWithdraw(rewardToken.address, owner.address, amount);
            const finalBalance = await rewardToken.balanceOf(owner.address);
            
            expect(finalBalance.sub(initialBalance)).to.equal(amount);
        });

        it("reverts when native transfer fails (attempting to send more than balance)", async () => {
            const signers = await ethers.getSigners();
            const owner = signers[0];
            
            // Fund with small amount
            await owner.sendTransaction({
                to: await incentives.address,
                value: ethers.utils.parseEther("0.1")
            });
            
            // Try to withdraw more than available - this will fail at the balance check
            // but won't revert with "Native transfer failed" since the call() will succeed
            // The EVM will revert due to insufficient balance before the call
            await expect(
                incentives.emergencyWithdraw(ZERO_ADDR, owner.address, ethers.utils.parseEther("1"))
            ).to.be.reverted;
        });
    });

    describe("Funding Mismatch Errors", () => {
        it("reverts when creating ERC20 program with native tokens sent", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("500", 18);
            
            await rewardToken.contract.deposit(await (await test1.trader).getAddress(), fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount, true,
                    { value: ethers.utils.parseEther("0.1") }
                )
            ).to.be.revertedWith("Cannot send native tokens for ERC20 program");
        });

        it("reverts when creating native program with msg.value != fundingAmount", async () => {
            const rewardPerBlock = ethers.utils.parseEther("0.01");
            const fundingAmount = ethers.utils.parseEther("1");
            
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, ZERO_ADDR, rewardPerBlock, fundingAmount, true,
                    { value: ethers.utils.parseEther("0.5") } // Mismatch
                )
            ).to.be.revertedWith("Insufficient native token balance");
        });

        it("reverts when creating native program with zero funding", async () => {
            const rewardPerBlock = ethers.utils.parseEther("0.01");
            
            // With no balance in contract, zero funding should fail
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, ZERO_ADDR, rewardPerBlock, 0, true)
            ).to.be.revertedWith("Insufficient funding for at least one block");
        });

        it("reverts when creating ERC20 program with zero funding", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            // With no balance in contract, zero funding should fail
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, 0, true)
            ).to.be.revertedWith("Insufficient funding for at least one block");
        });
    });

    describe("Registration Edge Cases", () => {
        it("concentrated: reverts when registering for non-existent program", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const traderAddress = await (await test1.trader).getAddress();
            
            await expect(
                incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true)
            ).to.be.revertedWith("Program does not exist");
        });

        it("ambient: reverts when registering for non-existent program", async () => {
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            const traderAddress = await (await test1.trader).getAddress();
            
            await expect(
                incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false)
            ).to.be.revertedWith("Program does not exist");
        });

        it("concentrated: reverts when registering with zero net liquidity", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            // Try to register without providing liquidity
            await expect(
                incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true)
            ).to.be.revertedWith("No net liquidity");
        });

        it("ambient: reverts when registering with zero net liquidity", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , false);
            
            await expect(
                incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false)
            ).to.be.revertedWith("No net liquidity");
        });

        it("concentrated: reverts when registering for inactive program", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            // Deactivate program
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            
            await expect(
                incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true)
            ).to.be.revertedWith("Program not active");
        });
    });

    describe("Claim/Withdraw Error Paths", () => {
        it("concentrated: claims minimal rewards when only 1 block passes", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            const balanceBefore = await rewardToken.balanceOf(traderAddress);
            
            // Claim immediately after registration - claim tx creates 1 more block
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            const balanceAfter = await rewardToken.balanceOf(traderAddress);
            
            // Should get rewards for approximately 1 block (the registration block)
            expect(balanceAfter.sub(balanceBefore)).to.be.gte(rewardPerBlock);
        });

        it("ambient: claims minimal rewards when only 1 block passes", async () => {
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , false);
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);
            
            const balanceBefore = await rewardToken.balanceOf(traderAddress);

            // Claim immediately after registration - claim tx creates 1 more block  
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, false);
            
            const balanceAfter = await rewardToken.balanceOf(traderAddress);
            
            // Should get rewards for approximately 1 block (the registration block)
            expect(balanceAfter.sub(balanceBefore)).to.be.gte(rewardPerBlock);
        });

        it("concentrated: reverts when claiming from non-existent program", async () => {
            await expect(
                incentives.claimRewards(baseQuotePoolId, rewardToken.address, true)
            ).to.be.revertedWith("Program does not exist");
        });

        it("concentrated: reverts when claiming without registration", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            await expect(
                incentives.claimRewards(baseQuotePoolId, rewardToken.address, true)
            ).to.be.revertedWith("Not registered");
        });

        it("ambient: reverts when claiming without registration", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , false);
            
            await expect(
                incentives.claimRewards(baseQuotePoolId, rewardToken.address, false)
            ).to.be.revertedWith("Not registered");
        });

        it("concentrated: successfully claims rewards even after immediate claim", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            const balanceBefore = await rewardToken.balanceOf(traderAddress);
            
            // Claim immediately - registration block generates rewards
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            const balanceAfter = await rewardToken.balanceOf(traderAddress);
            
            // Should get rewards for at least 1 block
            expect(balanceAfter.sub(balanceBefore)).to.be.gte(rewardPerBlock);
        });
    });

    describe("Zero Liquidity Scenarios", () => {
        it("concentrated: accumulator updates correctly with zero liquidity (rewards not distributed)", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            // Don't add any liquidity
            // Wait for blocks to pass
            await hardhat.network.provider.send("hardhat_mine", [`0x${20}`]);
            
            // Now add liquidity and register
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Wait for 10 blocks with liquidity (mine 9, claim creates 10th)
            const blocksToWait = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);
            
            const initialBalance = await rewardToken.balanceOf(traderAddress);
            
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            const finalBalance = await rewardToken.balanceOf(traderAddress);
            
            // Should only get rewards for the blocks with liquidity, not the previous blocks
            expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(blocksToWait), ethers.utils.parseUnits("1", 18));
        });

        it("ambient: accumulator updates correctly with zero liquidity (rewards not distributed)", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , false);
            
            // Wait for blocks with no liquidity
            await hardhat.network.provider.send("hardhat_mine", [`0x${20}`]);
            
            const liq = 1000000;
            await test1.testMintAmbient(liq);
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);
            
            // Wait for 10 blocks with liquidity (mine 9, claim creates 10th)
            const blocksToWait = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);
            
            const initialBalance = await rewardToken.balanceOf(traderAddress);
            
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, false);
            
            const finalBalance = await rewardToken.balanceOf(traderAddress);
            
            expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(blocksToWait), ethers.utils.parseUnits("1", 18));
        });
    });

    describe("Deactivate Program Edge Cases", () => {
        it("reverts when deactivating non-existent program", async () => {
            await expect(
                incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true)
            ).to.be.revertedWith("Program does not exist");
        });

        it("can deactivate already inactive program", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);
            
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            
            // Deactivate again - should not revert
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            
            const isActive = await incentives.isProgramActive(baseQuotePoolId, rewardToken.address, true);
            expect(isActive).to.be.false;
        });
    });
});
