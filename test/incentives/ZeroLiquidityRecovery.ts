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

describe("Zero Liquidity Recovery Test", () => {
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

    it("Wasted rewards from zero liquidity periods are recovered on program reactivation", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const initialFunding = ethers.utils.parseUnits("1000", 18); // 100 blocks worth
        
        await rewardToken.contract.deposit(traderAddress, initialFunding);
        await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
        
        // Create program
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

        // Register a user to trigger accumulator updates
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq);
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

        // Mine some blocks with liquidity
        await hardhat.network.provider.send("hardhat_mine", ["0xA"]); // 10 blocks

        // User claims and unregisters by changing liquidity
        await test1.testMint(-5000, 8000, liq.mul(2)); // This changes liquidity, forces re-registration

        // Now NO ONE is registered (user's registration is invalid due to liquidity change)
        let program = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
        console.log("Total registered liquidity:", program.totalRegisteredLiquidity.toString());

        // Mine many blocks with ZERO registered liquidity
        // During this time, commitment will decrease but no rewards are distributed
        await hardhat.network.provider.send("hardhat_mine", ["0x32"]); // 50 blocks

        // Trigger an accumulator update (user tries to register with new liquidity)
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

        let commitment2 = await incentives.totalCommittedRewards(rewardToken.address);
        console.log("Commitment after zero-liquidity period:", ethers.utils.formatUnits(commitment2, 18));

        // Contract balance should still have all the tokens (none were paid out during zero liquidity)
        let contractBalance1 = await rewardToken.balanceOf(await incentives.address);
        console.log("Contract balance:", ethers.utils.formatUnits(contractBalance1, 18));

        // Wait for program to fully expire
        await hardhat.network.provider.send("hardhat_mine", ["0x64"]); // 100 more blocks

        // Check final state before reactivation
        let commitment3 = await incentives.totalCommittedRewards(rewardToken.address);
        console.log("Commitment after program expiry:", ethers.utils.formatUnits(commitment3, 18));

        // Contract should still have most of the original tokens
        let contractBalance2 = await rewardToken.balanceOf(await incentives.address);
        console.log("Contract balance before reactivation:", ethers.utils.formatUnits(contractBalance2, 18));

        // Calculate available balance
        let availableBefore = await incentives.getAvailableBalance(rewardToken.address);
        console.log("Available balance before reactivation:", ethers.utils.formatUnits(availableBefore, 18));

        // Now reactivate the program - it should use ALL available tokens, including "wasted" ones
        await incentives.createOrModifyProgram(
            baseQuotePoolId,
            rewardToken.address,
            rewardPerBlock,
            contractBalance2, // No new funding
            true
        );

        let programAfter = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
        let currentBlock = await ethers.provider.getBlockNumber();
        let newFundedBlocks = programAfter.endBlock.sub(currentBlock);
        
        console.log("New program funded blocks:", newFundedBlocks.toString());
        console.log("New endBlock:", programAfter.endBlock.toString());
        console.log("Current block:", currentBlock);

        // Calculate expected: all available balance should be used
        let expectedBlocks = contractBalance2.div(rewardPerBlock);
        console.log("Expected funded blocks:", expectedBlocks.toString());

        // The new program should be funded with approximately all the remaining tokens
        // (within a few blocks tolerance for transaction execution)
        expect(newFundedBlocks).to.be.closeTo(expectedBlocks, 5);

        // Verify available balance is now 0 (all funds committed to new program)
        let availableAfter = await incentives.getAvailableBalance(rewardToken.address);
        expect(availableAfter).to.equal(0);

        // Verify commitment equals contract balance (all tokens accounted for)
        let commitment4 = await incentives.totalCommittedRewards(rewardToken.address);
        let contractBalance3 = await rewardToken.balanceOf(await incentives.address);
        console.log("Final commitment:", ethers.utils.formatUnits(commitment4, 18));
        console.log("Final contract balance:", ethers.utils.formatUnits(contractBalance3, 18));
        
        expect(commitment4).to.equal(contractBalance3);

        console.log("\n✅ SUCCESS: Wasted rewards from zero liquidity periods were fully recovered!");
        console.log(`Recovered ${ethers.utils.formatUnits(contractBalance3, 18)} tokens for new program`);
    });

    it("Emergency withdraw can recover wasted tokens after program ends", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("5", 18);
        const initialFunding = ethers.utils.parseUnits("500", 18); // 100 blocks worth
        
        await rewardToken.contract.deposit(traderAddress, initialFunding);
        await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
        
        // Create program with no users registered (zero liquidity scenario)
        await incentives.createOrModifyProgram(
            baseQuotePoolId,
            rewardToken.address,
            rewardPerBlock,
            initialFunding,
            true
        );

        // Mine blocks past program end without anyone registering
        await hardhat.network.provider.send("hardhat_mine", ["0x96"]); // 150 blocks

        // Program should be expired
        let isActive = await incentives.isProgramActive(baseQuotePoolId, rewardToken.address, true);
        expect(isActive).to.be.false;

        // Commitment should be 0 or very low (as blocks passed without updates)
        // Actually, commitment won't decrease without accumulator updates
        // So we need to trigger an update first
        let program = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
        console.log("Program lastUpdateBlock:", program.lastUpdateBlock.toString());
        console.log("Program endBlock:", program.endBlock.toString());

        // Register someone to trigger an accumulator update (even though program is expired)
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq);
        
        // This should fail because program is exhausted, but let's check commitment first
        let commitmentBefore = await incentives.totalCommittedRewards(rewardToken.address);
        console.log("Commitment before any updates:", ethers.utils.formatUnits(commitmentBefore, 18));

        // Deactivate the program to release stale commitment
        await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);

        let commitmentAfter = await incentives.totalCommittedRewards(rewardToken.address);
        console.log("Commitment after deactivation:", ethers.utils.formatUnits(commitmentAfter, 18));

        // Now available balance should be equal to contract balance
        let contractBalance = await rewardToken.balanceOf(await incentives.address);
        let availableBalance = await incentives.getAvailableBalance(rewardToken.address);
        
        console.log("Contract balance:", ethers.utils.formatUnits(contractBalance, 18));
        console.log("Available balance:", ethers.utils.formatUnits(availableBalance, 18));

        expect(availableBalance).to.equal(contractBalance);

        // Emergency withdraw should work
        const owner = await incentives.owner();
        await incentives.emergencyWithdraw(rewardToken.address, owner, contractBalance);

        let finalBalance = await rewardToken.balanceOf(await incentives.address);
        expect(finalBalance).to.equal(0);

        console.log("\n✅ SUCCESS: Emergency withdraw recovered all wasted tokens!");
    });
});
