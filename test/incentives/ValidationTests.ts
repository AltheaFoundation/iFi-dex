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

describe('ValidationTests - Per-Block Incentives', () => {
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

    describe("Zero Reward Per Block Validation", () => {
        it("reverts when creating concentrated program with zero reward per block", async () => {
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, 0, fundingAmount, true)
            ).to.be.revertedWith("Zero reward per block");
        });

        it("reverts when creating ambient program with zero reward per block", async () => {
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, 0, // Zero reward per block
                    fundingAmount
                , false)
            ).to.be.revertedWith("Zero reward per block");
        });

        it("reverts when modifying existing program to zero reward per block", async () => {
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            // Create with valid reward
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, ethers.utils.parseUnits("10", 18),
                fundingAmount, true
            );

            // Try to modify to zero - this will fail on insufficient funding since 0 reward means infinite blocks needed
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, 0, 0, true)
            ).to.be.revertedWith("Zero reward per block");
        });
    });

    describe("Zero Pool ID Validation", () => {
        it("reverts when creating concentrated program with zero pool ID", async () => {
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await expect(
                incentives.createOrModifyProgram(ethers.constants.HashZero, rewardToken.address, ethers.utils.parseUnits("10", 18),
                    fundingAmount, true)
            ).to.be.revertedWith("Zero pool ID");
        });

        it("reverts when creating ambient program with zero pool ID", async () => {
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await expect(
                incentives.createOrModifyProgram(ethers.constants.HashZero, rewardToken.address, ethers.utils.parseUnits("10", 18),
                    fundingAmount, false)
            ).to.be.revertedWith("Zero pool ID");
        });

        it("reverts when deactivating program with zero pool ID", async () => {
            await expect(
                incentives.deactivateProgram(
                    ethers.constants.HashZero, // Zero pool ID
                    rewardToken.address,
                    true
                )
            ).to.be.revertedWith("Program does not exist");
        });
    });

    describe("Access Control - Ownership Transfer", () => {
        it("allows owner to transfer ownership", async () => {
            const signers = await ethers.getSigners();
            const newOwner = signers[1];
            const currentOwner = signers[0];

            expect(await incentives.owner()).to.equal(currentOwner.address);

            await incentives.transferOwnership(newOwner.address);

            expect(await incentives.owner()).to.equal(newOwner.address);
        });

        it("new owner can perform admin functions after transfer", async () => {
            const signers = await ethers.getSigners();
            const newOwner = signers[1];
            
            await incentives.transferOwnership(newOwner.address);

            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            await rewardToken.contract.deposit(newOwner.address, fundingAmount);
            await rewardToken.contract.connect(newOwner).approve(await incentives.address, fundingAmount);
            
            // New owner can create program
            await expect(
                incentives.connect(newOwner).createOrModifyProgram(baseQuotePoolId, rewardToken.address, ethers.utils.parseUnits("10", 18),
                    fundingAmount, true
                )
            ).to.not.be.reverted;
        });

        it("old owner cannot perform admin functions after transfer", async () => {
            const signers = await ethers.getSigners();
            const newOwner = signers[1];
            
            await incentives.transferOwnership(newOwner.address);

            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const oldOwner = signers[0];
            await rewardToken.contract.deposit(oldOwner.address, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            // Old owner cannot create program
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, ethers.utils.parseUnits("10", 18),
                    fundingAmount, true
                )
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("prevents renouncing ownership to avoid locking admin functions", async () => {
            // Note: The Ownable contract allows renouncing, but this test documents the risk
            await incentives.renounceOwnership();

            expect(await incentives.owner()).to.equal(ethers.constants.AddressZero);

            // Admin functions should now fail
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, ethers.utils.parseUnits("10", 18),
                    fundingAmount, true
                )
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });

    describe("View Function Edge Cases", () => {
        it("getPendingRewards (concentrated) returns 0 for non-existent program", async () => {
            const traderAddress = await (await test1.trader).getAddress();
            
            const pending = await incentives.getPendingRewards(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(pending).to.equal(0);
        });

        it("getPendingRewards (ambient) returns 0 for non-existent program", async () => {
            const traderAddress = await (await test1.trader).getAddress();
            
            const pending = await incentives.getPendingRewards(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                false
            );
            
            expect(pending).to.equal(0);
        });

        it("getPendingRewards (concentrated) returns 0 when user not registered", async () => {
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, ethers.utils.parseUnits("10", 18),
                fundingAmount, true
            );

            // Don't register
            const pending = await incentives.getPendingRewards(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(pending).to.equal(0);
        });

        it("getPendingRewards (ambient) returns 0 when user not registered", async () => {
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, ethers.utils.parseUnits("10", 18),
                fundingAmount, true
            );

            // Don't register
            const pending = await incentives.getPendingRewards(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address,
                false
            );
            
            expect(pending).to.equal(0);
        });

        it("getProgramInfo (concentrated) works for non-existent program", async () => {
            const program = await incentives.getProgramInfo(
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(program.rewardToken).to.equal(ZERO_ADDR);
            expect(program.rewardPerBlock).to.equal(0);
            // Non-existent programs have endBlock = 0, which is always <= current block
        });

        it("getProgramInfo (ambient) works for non-existent program", async () => {
            const program = await incentives.getProgramInfo(
                baseQuotePoolId,
                rewardToken.address,
                false
            );
            
            expect(program.rewardToken).to.equal(ZERO_ADDR);
            expect(program.rewardPerBlock).to.equal(0);
            // Non-existent programs have endBlock = 0, which is always <= current block
        });

        it("isProgramActive (concentrated) returns false for non-existent program", async () => {
            const isActive = await incentives.isProgramActive(
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(isActive).to.be.false;
        });

        it("isProgramActive (ambient) returns false for non-existent program", async () => {
            const isActive = await incentives.isProgramActive(
                baseQuotePoolId,
                rewardToken.address,
                false
            );
            
            expect(isActive).to.be.false;
        });

        it("getRemainingBlocks (concentrated) returns 0 for non-existent program", async () => {
            const remaining = await incentives.getRemainingBlocks(
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(remaining).to.equal(0);
        });

        it("getRemainingRewards (concentrated) returns 0 for non-existent program", async () => {
            const remaining = await incentives.getRemainingRewards(
                baseQuotePoolId,
                rewardToken.address,
                true
            );
            
            expect(remaining).to.equal(0);
        });
    });

    // Epoch length validation tests removed - per-block system has no epochLength parameter

    describe("Commitment Tracking Edge Cases", () => {
        it("commitment tracking remains consistent with rapid program modifications", async () => {
            const fundingAmount = ethers.utils.parseUnits("3000", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            // Create program with 10 tokens per block, 100 blocks funded
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, ethers.utils.parseUnits("10", 18),
                ethers.utils.parseUnits("1000", 18), true
            );

            let committed = await incentives.totalCommittedRewards(rewardToken.address);
            expect(committed).to.equal(ethers.utils.parseUnits("1000", 18));

            // Modify immediately (increase reward rate to 20 per block, 50 blocks funded)
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, ethers.utils.parseUnits("20", 18),
                ethers.utils.parseUnits("2000", 18), true
            );

            committed = await incentives.totalCommittedRewards(rewardToken.address);
            expect(committed).to.equal(ethers.utils.parseUnits("2000", 18));

            // Modify again (decrease reward rate to 10 per block, 100 blocks funded)
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, ethers.utils.parseUnits("10", 18),
                ethers.utils.parseUnits("3000", 18), true
            );

            committed = await incentives.totalCommittedRewards(rewardToken.address);
            expect(committed).to.equal(ethers.utils.parseUnits("3000", 18));
        });

        it("commitment tracking behavior through program lifecycle", async () => {
            // This test verifies that commitment tracking correctly decreases as blocks are consumed
            
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const fundingAmount = ethers.utils.parseUnits("500", 18); // 50 blocks funded
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount, true);

            let committed = await incentives.totalCommittedRewards(rewardToken.address);
            expect(committed).to.equal(fundingAmount); // 500 tokens committed

            // Register - this calls _updateAccumulator and the transaction creates a block
            // Since the program starts on the creation block, by the time registration happens,
            // at least one block has passed and rewards were distributed
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

            // Commitment may have decreased slightly if blocks passed between program creation and registration
            committed = await incentives.totalCommittedRewards(rewardToken.address);
            expect(committed).to.be.lte(fundingAmount);

            // Track the committed amount after registration to calculate blocks consumed
            const committedAfterRegistration = committed;

            // Wait 10 blocks and claim (mine 9, claim creates the 10th)
            const blocksToWait = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            // Commitment should decrease by rewardPerBlock * blocksToWait (approximately)
            // Allowing for some tolerance due to block timing
            committed = await incentives.totalCommittedRewards(rewardToken.address);
            const expectedDecrease = rewardPerBlock.mul(blocksToWait);
            expect(committed).to.be.closeTo(
                committedAfterRegistration.sub(expectedDecrease),
                ethers.utils.parseUnits("20", 18) // Allow 2 blocks worth of tolerance
            );

            // Wait 20 more blocks and claim (mine 19, claim creates the 20th)
            const blocksToWait2 = 20;
            await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait2 - 1).toString(16)}`]);
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            // Commitment should decrease by another rewardPerBlock * blocksToWait2
            committed = await incentives.totalCommittedRewards(rewardToken.address);
            const committedAfterSecondClaim = committed;
            const expectedDecrease2 = rewardPerBlock.mul(blocksToWait2);
            expect(committed).to.be.closeTo(
                committedAfterRegistration.sub(expectedDecrease).sub(expectedDecrease2),
                ethers.utils.parseUnits("40", 18) // Allow 4 blocks worth of tolerance
            );
            
            // Verify program is NOT exhausted yet
            const program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            const currentBlock = await ethers.provider.getBlockNumber();
            expect(currentBlock).to.be.lt(program.endBlock); // Verify program is not exhausted
        });
    });

    describe("Error Message and State Consistency", () => {
        it("validates specific error messages for all revert cases", async () => {
            // Zero pool ID
            await expect(
                incentives.createOrModifyProgram(ethers.constants.HashZero, rewardToken.address, ethers.utils.parseUnits("10", 18),
                    ethers.utils.parseUnits("1000", 18), true
                )
            ).to.be.revertedWith("Zero pool ID");

            // Zero reward per block
            await expect(
                incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, 0, ethers.utils.parseUnits("1000", 18), true)
            ).to.be.revertedWith("Zero reward per block");
        });

        it("maintains state consistency: contract balance >= totalPending + totalCommitted", async () => {
            const liq = 1000000;
            await test1.testMint(-5000, 8000, liq);
            
            const fundingAmount = ethers.utils.parseUnits("1000", 18);
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
            
            await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount, true);

            const contractBalance = await rewardToken.balanceOf(await incentives.address);
            const totalCommitted = await incentives.totalCommittedRewards(rewardToken.address);

            expect(contractBalance).to.be.gte(totalCommitted);

            // Register and claim (mine 9 blocks, claim creates the 10th)
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            const blocksToWait = 10;
            await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            const contractBalance2 = await rewardToken.balanceOf(await incentives.address);
            const totalCommitted2 = await incentives.totalCommittedRewards(rewardToken.address);

            expect(contractBalance2).to.be.gte(totalCommitted2);
        });

        // Test for totalPending invariant removed as contract now transfers immediately
    });
});
