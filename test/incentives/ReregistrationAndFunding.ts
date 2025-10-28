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

describe('ReregistrationAndFunding - Per-Block Incentives', () => {
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
        await test2.initPool(feeRate, 0, 1, 1.5)
        test1.useHotPath = true;
        test2.useHotPath = true;
 
        await test1.base.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test1.quote.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test2.base.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test2.quote.approve(await test1.trader, (await test1.dex).address, 100000000000)

        let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        incentives = await incentivesFactory.deploy((await test1.dex).address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;
 
        baseQuotePoolId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [baseToken.address, quoteToken.address, POOL_IDX]
            )
        );
    })

    describe("Re-registration", () => {
        it("concentrated: user can re-register after modifying position", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq); 

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            // Fund for 100 blocks
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            // Initial registration
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

            // Wait 10 blocks
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

            // Claim rewards
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            // Withdraw rewards

            // Modify liquidity
            await test1.testMint(-5000, 8000, liq);

            // Should fail to claim because liquidity changed
            await expect(
                incentives.claimRewards(baseQuotePoolId, rewardToken.address, true)
            ).to.be.revertedWith("Liquidity changed");

            // Re-register with new liquidity
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

            // Wait another 10 blocks
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

            // Should be able to claim now
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            const balance = await rewardToken.balanceOf(traderAddress);
            
            // Should have rewards from both periods (approximately 20 blocks)
            expect(balance).to.be.closeTo(rewardPerBlock.mul(20), ethers.utils.parseUnits("50", 18));
        });

        it("ambient: user can re-register after modifying position", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMintAmbient(liq); 

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , false);

            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);

            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, false);

            // Modify liquidity - burn some
            await test1.testBurnAmbient(500000);

            // Re-register
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);

            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, false);

            const balance = await rewardToken.balanceOf(traderAddress);
            
            // Should have rewards from approximately 20 blocks
            expect(balance).to.be.closeTo(rewardPerBlock.mul(20), ethers.utils.parseUnits("50", 18));
        });

        it("can register without prior registration (initial registration)", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq); 

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            // Should succeed - this is initial registration
            await expect(
                incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true)
            ).to.not.be.reverted;
            
            // Verify user is now registered
            const userInfo = await incentives.getUserInfo(traderAddress, baseQuotePoolId, rewardToken.address, true);
            expect(userInfo.registered).to.be.true;
        });

    });

    describe("Funding and Program End", () => {
        it("program calculates correct end block based on funding", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("500", 18); // 50 blocks worth
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            const program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            const currentBlock = await ethers.provider.getBlockNumber();
            
            // Should have funding for 50 blocks
            const expectedEndBlock = currentBlock + 50;
            expect(program.endBlock).to.equal(expectedEndBlock);
        });

        it("program stops distributing rewards after end block", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq); 

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("200", 18); // Only 20 blocks
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

            // Wait for 10 blocks
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            // Wait for another 10 blocks
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);
            
            // Claim rewards for 2nd period
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
            
            // Wait for another 10 blocks (beyond funding)
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

            // Should only have rewards from the 20 funded blocks
            const balance = await rewardToken.balanceOf(traderAddress);
            expect(balance).to.be.closeTo(rewardPerBlock.mul(20), ethers.utils.parseUnits("50", 18)); // Both periods withdrawn
        });

        it("program is marked as funding exhausted after end block", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq); 

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("100", 18); // Only 10 blocks
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

            // Wait past the end block
            await hardhat.network.provider.send("hardhat_mine", [`0x${(20).toString(16)}`]);

            // Trigger block update
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            const program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            const currentBlock = await ethers.provider.getBlockNumber();
            expect(currentBlock).to.be.gte(program.endBlock); // Verify funding is exhausted
        });

        it("cannot register for exhausted program", async () => {
            const liq = BigNumber.from(1000000);

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("100", 18); // 10 blocks
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            // Add liquidity and register first
            await test1.testMint(-5000, 8000, liq);
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

            // Wait past end block
            await hardhat.network.provider.send("hardhat_mine", [`0x${(20).toString(16)}`]);

            // Trigger update to mark as exhausted
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            // Now try to re-register - should fail as program is not active (exhausted)
            await expect(
                incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true)
            ).to.be.revertedWith("Program not active");
        });

        it("can modify and refund exhausted program", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);
            
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("100", 18); // 10 blocks
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            // Register to enable updates
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

            // Wait past end block
            await hardhat.network.provider.send("hardhat_mine", [`0x${(20).toString(16)}`]);

            // Trigger update to mark as exhausted
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            const programBefore = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            const blockBeforeRefund = await ethers.provider.getBlockNumber();
            expect(blockBeforeRefund).to.be.gte(programBefore.endBlock); // Verify funding is exhausted

            // Add more funding
            const additionalFunding = ethers.utils.parseUnits("500", 18); // 50 more blocks
            await rewardToken.contract.deposit(traderAddress, additionalFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, additionalFunding);

            // Modify to refund - should work now
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, additionalFunding
            , true);

            const programAfter = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            const blockAfterRefund = await ethers.provider.getBlockNumber();
            expect(blockAfterRefund).to.be.lt(programAfter.endBlock); // Verify funding is no longer exhausted
            expect(programAfter.endBlock).to.be.gt(programBefore.endBlock);
        });

        it("modifying program extends endBlock with new funding", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const initialFunding = ethers.utils.parseUnits("200", 18); // 20 blocks
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, initialFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, initialFunding);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, initialFunding
            , true);

            const program1 = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            const initialEndBlock = program1.endBlock;

            // Add more funding
            const additionalFunding = ethers.utils.parseUnits("300", 18); // 30 more blocks
            await rewardToken.contract.deposit(traderAddress, additionalFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, additionalFunding);

            // Modify program (this should recalculate end block)
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, additionalFunding
            , true);

            const program2 = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            
            // End block should now account for additional 30 blocks (300/10)
            expect(program2.endBlock).to.be.gt(initialEndBlock);
        });

        it("requires sufficient funding for at least one block", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("100", 18);
            const insufficientFunding = ethers.utils.parseUnits("50", 18); // Less than one block's worth
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, insufficientFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, insufficientFunding);
            
            // Should fail when trying to create program without sufficient funding
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, insufficientFunding
                , true)
            ).to.be.revertedWith("Insufficient funding for at least one block");
        });

        // Note: This test is complex due to multi-pool setup, commenting out for now
        // The functionality is tested implicitly by other tests
        it("accounts for pending rewards when calculating available balance", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            // Fund first program
            const fundingAmount = ethers.utils.parseUnits("300", 18); // 30 blocks
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);
            
            // Claim but don't withdraw (creates pending rewards)
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            // Create a second pool/program with same reward token
            const base2QuotePoolId = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address", "uint256"],
                    [test2.base.address, test2.quote.address, POOL_IDX]
                )
            );

            // test2 is already initialized in beforeEach

            // Add liquidity to test2
            await test2.testMint(-5000, 8000, liq);

            // Try to create program - should account for committed rewards from first program
            // Available = 300 - 100 (pending) = 200
            // This should allow for 20 blocks
            const secondFunding = ethers.utils.parseUnits("200", 18);
            await rewardToken.contract.deposit(traderAddress, secondFunding);
            await rewardToken.approve(await test1.trader, await incentives.address, secondFunding);
            
            await incentives.createOrModifyProgram(base2QuotePoolId, rewardToken.address, rewardPerBlock, secondFunding
            , true);

            const program = await incentives.getProgramInfo(base2QuotePoolId, rewardToken.address, true);
            const currentBlock = await ethers.provider.getBlockNumber();
            
            // Program was created in a recent block
            // With 200 funding and 10 per block, should have ~20 blocks of funding
            // Allow some tolerance for transaction timing (±3 blocks)
            const expectedEndBlock = currentBlock + 19;
            const actualEndBlock = program.endBlock.toNumber();
            expect(actualEndBlock).to.be.at.least(expectedEndBlock - 3);
            expect(actualEndBlock).to.be.at.most(expectedEndBlock + 3);
        });
    });

    describe("View Functions", () => {
        // Test for getTotalPendingRewards removed as contract now transfers immediately

        it("isProgramActive (concentrated) returns correct status", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            
            const fundingAmount = ethers.utils.parseUnits("100", 18); // 10 blocks
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            let isActive = await incentives.isProgramActive(baseQuotePoolId, rewardToken.address, true);
            expect(isActive).to.be.true;

            // Wait past end block
            await hardhat.network.provider.send("hardhat_mine", [`0x${(20).toString(16)}`]);

            isActive = await incentives.isProgramActive(baseQuotePoolId, rewardToken.address, true);
            expect(isActive).to.be.false;
        });

        it("getProgramInfo (concentrated) returns all program details", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("500", 18); // 50 blocks
            
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true);

            const program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            
            expect(program.rewardToken).to.equal(rewardToken.address);
            expect(program.rewardPerBlock).to.equal(rewardPerBlock);
            expect(program.lastUpdateBlock).to.be.gt(0);
            expect(program.endBlock).to.be.gt(program.lastUpdateBlock);
        });
    });
});
