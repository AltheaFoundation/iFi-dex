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

describe("TotalCommittedRewards Double-Counting Bug", () => {
    let test1: TestPool;
    let test2: TestPool;
    let test3: TestPool;
    let baseToken: ERC20Token;
    let quoteToken: ERC20Token;
    let rewardToken: ERC20Token;
    const feeRate = 225 * 100;
    let incentives: AltheaDexIncentivesContinuousEpochMulti;
    let baseQuotePoolId: string;
    let traderAddress: string;

    beforeEach("deploy and setup", async () => {
        [test1, test2, test3] = await makeTokenTriangle();
        baseToken = await test1.base;
        quoteToken = await test1.quote;
        rewardToken = await makeStandaloneToken();

        await test1.initPool(feeRate, 0, 1, 1.5);
        test1.useHotPath = true;

        await test1.base.approve(await test1.trader, (await test1.dex).address, 100000000000);
        await test1.quote.approve(await test1.trader, (await test1.dex).address, 100000000000);

        let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        incentives = await incentivesFactory.deploy((await test1.dex).address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;

        baseQuotePoolId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [baseToken.address, quoteToken.address, POOL_IDX]
            )
        );

        traderAddress = await (await test1.trader).getAddress();
    });

    it("CRITICAL: Program expiring without updates leaves commitment stuck in totalCommittedRewards", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const initialFunding = ethers.utils.parseUnits("100", 18); // Only 10 blocks
        
        await rewardToken.contract.deposit(traderAddress, initialFunding.mul(2));
        await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
        
        // Create program that will expire soon
        await incentives.createOrModifyProgram(
            baseQuotePoolId,
            rewardToken.address,
            rewardPerBlock,
            initialFunding,
            true
        );

        let commitment1 = await incentives.totalCommittedRewards(rewardToken.address);
        console.log("Initial commitment:", ethers.utils.formatUnits(commitment1, 18));
        expect(commitment1).to.equal(initialFunding);

        let program = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
        console.log("Program endBlock:", program.endBlock.toString());
        console.log("Current block:", await ethers.provider.getBlockNumber());

        // Mine past the endBlock WITHOUT any accumulator updates (no users registered)
        await hardhat.network.provider.send("hardhat_mine", ["0x32"]); // 50 blocks

        let currentBlock = await ethers.provider.getBlockNumber();
        console.log("Current block after mining:", currentBlock);
        
        // Program is now exhausted
        let isActive = await incentives.isProgramActive(baseQuotePoolId, rewardToken.address, true);
        expect(isActive).to.be.false;

        // BUT totalCommittedRewards still has the full commitment!
        let commitment2 = await incentives.totalCommittedRewards(rewardToken.address);
        console.log("Commitment after expiry (NO UPDATE!):", ethers.utils.formatUnits(commitment2, 18));
        
        // THIS IS THE BUG: commitment2 should be 0 or near 0, but it's still the full 100!
        // The commitment was never released because no accumulator update happened
        expect(commitment2).to.equal(initialFunding); // BUG: Still has full commitment!

        // Now try to reactivate - the wasDeactivated path doesn't clean up old commitment
        await incentives.createOrModifyProgram(
            baseQuotePoolId,
            rewardToken.address,
            rewardPerBlock,
            initialFunding,
            true
        );

        let commitment3 = await incentives.totalCommittedRewards(rewardToken.address);
        console.log("Commitment after reactivation:", ethers.utils.formatUnits(commitment3, 18));
        
        // Check contract balance
        let contractBalance = await rewardToken.balanceOf(await incentives.address);
        console.log("Contract balance:", ethers.utils.formatUnits(contractBalance, 18));

        // Expected: should be approximately initialFunding (one program's worth)
        // Actual: might be 2x initialFunding due to bug!
        program = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
        currentBlock = await ethers.provider.getBlockNumber();
        let expectedRemainingBlocks = program.endBlock.sub(currentBlock);
        let expectedCommitment = expectedRemainingBlocks.mul(rewardPerBlock);
        
        console.log("Expected commitment (based on program):", ethers.utils.formatUnits(expectedCommitment, 18));
        console.log("Expected remaining blocks:", expectedRemainingBlocks.toString());
        console.log("Contract has tokens:", ethers.utils.formatUnits(contractBalance, 18));
        console.log("Committed in accounting:", ethers.utils.formatUnits(commitment3, 18));
        console.log("Available balance:", ethers.utils.formatUnits(await incentives.getAvailableBalance(rewardToken.address), 18));

        // After the fix:
        // - Old program's 100 token commitment is released
        // - Contract has 200 tokens total (100 from first funding + 100 from second)
        // - New program uses all available 200 tokens
        // - totalCommittedRewards should be 200 (the new program's commitment)
        
        // Verify the commitment matches the actual program's remaining blocks * rate
        expect(commitment3).to.equal(expectedCommitment);
        
        // Verify available balance is 0 (all tokens are committed to the new program)
        let availableBalance = await incentives.getAvailableBalance(rewardToken.address);
        expect(availableBalance).to.equal(0);
        
        // Verify contract balance equals committed amount (all funds are accounted for)
        expect(contractBalance).to.equal(commitment3);
    });

    it("CRITICAL: totalCommittedRewards should accurately track commitment without accumulator update", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("1", 18); // 1 token per block
        const initialFunding = ethers.utils.parseUnits("1000", 18); // Fund for 1000 blocks
        
        // Fund and create initial program
        await rewardToken.contract.deposit(traderAddress, initialFunding);
        await rewardToken.approve(await test1.trader, await incentives.address, initialFunding);
        
        await incentives.createOrModifyProgram(
            baseQuotePoolId,
            rewardToken.address,
            rewardPerBlock,
            initialFunding,
            true
        );

        // Check initial commitment - should be 1000 tokens
        let commitment1 = await incentives.totalCommittedRewards(rewardToken.address);
        expect(commitment1).to.equal(initialFunding);

        // Mine 10 blocks WITHOUT triggering accumulator update (no user registered)
        await hardhat.network.provider.send("hardhat_mine", ["0xA"]); // 10 blocks

        // Read commitment - should still be 1000 because accumulator hasn't updated
        let commitment2 = await incentives.totalCommittedRewards(rewardToken.address);
        expect(commitment2).to.equal(initialFunding); // Still 1000 because no update
        
        // Now modify the program with additional funding WITHOUT any user registered
        // This is the critical test: does it correctly calculate oldCommitment?
        const additionalFunding = ethers.utils.parseUnits("500", 18);
        await rewardToken.contract.deposit(traderAddress, additionalFunding);
        await rewardToken.approve(await test1.trader, await incentives.address, additionalFunding);
        
        let programBefore = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
        let currentBlockBefore = await ethers.provider.getBlockNumber();
        
        // Expected: oldCommitment should be calculated BEFORE _updateAccumulator is called
        // Since no users are registered, _updateAccumulator won't be called
        // So oldCommitment = (endBlock - lastUpdateBlock) * rewardPerBlock
        // Which is the full remaining commitment from creation
        
        await incentives.createOrModifyProgram(
            baseQuotePoolId,
            rewardToken.address,
            rewardPerBlock,
            additionalFunding,
            true
        );

        let commitment3 = await incentives.totalCommittedRewards(rewardToken.address);
        let programAfter = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
        let currentBlockAfter = await ethers.provider.getBlockNumber();
        
        // Calculate expected: all new blocks from current point
        let expectedRemainingBlocks = programAfter.endBlock.sub(currentBlockAfter);
        let expectedCommitment = expectedRemainingBlocks.mul(rewardPerBlock);
        
        console.log("Expected commitment:", ethers.utils.formatUnits(expectedCommitment, 18));
        console.log("Actual commitment:", ethers.utils.formatUnits(commitment3, 18));
        console.log("Expected remaining blocks:", expectedRemainingBlocks.toString());
        console.log("Old endBlock:", programBefore.endBlock.toString());
        console.log("New endBlock:", programAfter.endBlock.toString());
        
        const tolerance = ethers.utils.parseUnits("5", 18); // Small tolerance for tx blocks
        expect(commitment3).to.be.closeTo(expectedCommitment, tolerance);
    });

    it("CRITICAL: Demonstrates totalCommittedRewards can underflow or become incorrect", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const initialFunding = ethers.utils.parseUnits("1000", 18); // 100 blocks
        
        await rewardToken.contract.deposit(traderAddress, initialFunding.mul(3));
        await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
        
        await incentives.createOrModifyProgram(
            baseQuotePoolId,
            rewardToken.address,
            rewardPerBlock,
            initialFunding,
            true
        );

        // Register user to enable updates
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq);
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

        // Mine many blocks
        await hardhat.network.provider.send("hardhat_mine", ["0x32"]); // 50 blocks

        let commitmentBefore = await incentives.totalCommittedRewards(rewardToken.address);
        console.log("Commitment before modification:", ethers.utils.formatUnits(commitmentBefore, 18));

        // Modify with more funding - this triggers the double-counting bug
        await incentives.createOrModifyProgram(
            baseQuotePoolId,
            rewardToken.address,
            rewardPerBlock,
            initialFunding,
            true
        );

        let commitmentAfter = await incentives.totalCommittedRewards(rewardToken.address);
        console.log("Commitment after modification:", ethers.utils.formatUnits(commitmentAfter, 18));

        // Get program state
        let program = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
        let currentBlock = await ethers.provider.getBlockNumber();
        let remainingBlocks = program.endBlock.sub(currentBlock);
        let expectedCommitment = remainingBlocks.mul(rewardPerBlock);
        
        console.log("Expected commitment:", ethers.utils.formatUnits(expectedCommitment, 18));
        console.log("Remaining blocks:", remainingBlocks.toString());

        // The commitment should match expected (within tolerance for tx execution)
        const tolerance = ethers.utils.parseUnits("50", 18);
        expect(commitmentAfter).to.be.closeTo(expectedCommitment, tolerance);
    });

    it("Multiple modifications amplify the accounting error", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("5", 18);
        const fundingAmount = ethers.utils.parseUnits("500", 18);
        
        await rewardToken.contract.deposit(traderAddress, fundingAmount.mul(10));
        await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
        
        // Create initial program
        await incentives.createOrModifyProgram(
            baseQuotePoolId,
            rewardToken.address,
            rewardPerBlock,
            fundingAmount,
            true
        );

        // Register user
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq);
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

        // Track commitments through multiple modifications
        let commitments: BigNumber[] = [];
        commitments.push(await incentives.totalCommittedRewards(rewardToken.address));
        
        // Perform multiple modifications
        for (let i = 0; i < 3; i++) {
            await hardhat.network.provider.send("hardhat_mine", ["0xA"]); // 10 blocks
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );
            
            commitments.push(await incentives.totalCommittedRewards(rewardToken.address));
            console.log(`Commitment after modification ${i + 1}:`, ethers.utils.formatUnits(commitments[commitments.length - 1], 18));
        }

        // Final check: commitment should match actual remaining obligations
        let program = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
        let currentBlock = await ethers.provider.getBlockNumber();
        let remainingBlocks = program.endBlock.sub(currentBlock);
        let expectedCommitment = remainingBlocks.mul(rewardPerBlock);
        
        console.log("Final expected commitment:", ethers.utils.formatUnits(expectedCommitment, 18));
        console.log("Final actual commitment:", ethers.utils.formatUnits(commitments[commitments.length - 1], 18));

        const tolerance = ethers.utils.parseUnits("100", 18);
        expect(commitments[commitments.length - 1]).to.be.closeTo(expectedCommitment, tolerance);
    });
});
