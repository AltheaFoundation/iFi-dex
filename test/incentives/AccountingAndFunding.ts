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

describe("Incentives Accounting And Funding Tests", () => {
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

    describe("Basic Accounting Tests", () => {
        it("totalCommittedRewards tracks future obligations correctly", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("1", 18); // 1 token per block
            const fundingAmount = ethers.utils.parseUnits("1000", 18); // Fund for 1000 blocks

            // Deposit tokens to trader, then approve and fund the program
            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);

            // Initially no commitments
            expect(await incentives.totalCommittedRewards(rewardToken.address)).to.equal(0);

            // Create program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Should have commitment for 1000 blocks
            expect(await incentives.totalCommittedRewards(rewardToken.address)).to.equal(fundingAmount);

            // Mine some blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x5"]); // Mine 5 blocks

            // Add liquidity and register to trigger accumulator update
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq); // Concentrated liquidity
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true); // Concentrated

            // Commitment should have decreased (less than initial funding)
            const currentCommitment = await incentives.totalCommittedRewards(rewardToken.address);
            expect(currentCommitment).to.be.lt(fundingAmount);
        });

        it("deactivating a program releases remaining commitments", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("1", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);

            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);

            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            const initialCommitment = await incentives.totalCommittedRewards(rewardToken.address);
            expect(initialCommitment).to.equal(fundingAmount);

            // Mine a few blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x5"]);

            // Deactivate program
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);

            // All commitments should be released
            expect(await incentives.totalCommittedRewards(rewardToken.address)).to.equal(0);
        });

        it("exhausted programs release all commitments when updated", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("1", 18);
            const fundingAmount = ethers.utils.parseUnits("10", 18); // Only 10 blocks

            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);

            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            expect(await incentives.totalCommittedRewards(rewardToken.address)).to.equal(fundingAmount);

            // Register first so we can later see the exhaustion
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq); // Concentrated liquidity
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true); // Concentrated

            // Mine past the end block
            await hardhat.network.provider.send("hardhat_mine", ["0x14"]); // Mine 20 blocks

            // Claim rewards to trigger accumulator update (can't register again when exhausted)
            await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

            // All commitments should be released
            expect(await incentives.totalCommittedRewards(rewardToken.address)).to.equal(0);
        });
    });

    describe("Available Balance Tests", () => {
        it("getAvailableBalance returns contract balance minus commitments", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("1", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);

            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);

            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            const contractBalance = await rewardToken.balanceOf(await incentives.address);
            const commitment = await incentives.totalCommittedRewards(rewardToken.address);
            const available = await incentives.getAvailableBalance(rewardToken.address);

            expect(available).to.equal(contractBalance.sub(commitment));
        });

        it("can use directly sent tokens for programs", async () => {
            const directAmount = ethers.utils.parseUnits("5", 18); // 5 tokens

            // Deposit and send tokens directly to contract
            await rewardToken.contract.deposit(traderAddress, directAmount);
            await rewardToken.contract.connect(await test1.trader).transfer(await incentives.address, directAmount);

            // Check available balance includes directly sent tokens
            const available = await incentives.getAvailableBalance(rewardToken.address);
            expect(available).to.be.gte(directAmount);

            // Create program using those tokens (no new funding needed)
            const rewardPerBlock = ethers.utils.parseUnits("1", 18);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                rewardPerBlock,
                0, // No new funding - using directly sent tokens
                true
            );

            const program = await incentives.concentratedPrograms(baseQuotePoolId, rewardToken.address);
            const isActive = await incentives.isProgramActive(baseQuotePoolId, rewardToken.address, true);
            expect(isActive).to.be.true;
        });
    });

    describe("Native Token Accounting", () => {
        it("tracks native token commitments separately", async () => {
            const rewardPerBlock = ethers.utils.parseUnits("1", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);

            // Create native token program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                ZERO_ADDR,
                rewardPerBlock,
                fundingAmount,
                true,
                { value: fundingAmount }
            );

            // Native token commitment should be tracked
            const nativeCommitment = await incentives.totalCommittedRewards(ZERO_ADDR);
            expect(nativeCommitment).to.equal(fundingAmount);

            // ERC20 commitment should be zero
            const erc20Commitment = await incentives.totalCommittedRewards(rewardToken.address);
            expect(erc20Commitment).to.equal(0);
        });

        it("can use directly sent native tokens for programs", async () => {
            const directAmount = ethers.utils.parseUnits("5", 18);

            // Send ETH directly to contract
            const trader = await test1.trader;
            await trader.sendTransaction({
                to: await incentives.address,
                value: directAmount
            });

            // Check available balance
            const available = await incentives.getAvailableBalance(ZERO_ADDR);
            expect(available).to.be.gte(directAmount);

            // Create program using those tokens (no new funding needed)
            const rewardPerBlock = ethers.utils.parseUnits("1", 18);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                ZERO_ADDR,
                rewardPerBlock,
                0,
                true
            );

            const program = await incentives.concentratedPrograms(baseQuotePoolId, ZERO_ADDR);
            const isActive = await incentives.isProgramActive(baseQuotePoolId, ZERO_ADDR, true);
            expect(isActive).to.be.true;
        });
    });
});
