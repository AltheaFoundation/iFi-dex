import { TestPool, makeTokenPool, Token, makeEtherPool, POOL_IDX, ERC20Token, makeStandaloneToken, makeTokenTriangle } from '../FacadePool'
import { expect } from "chai";
import "@nomiclabs/hardhat-ethers";
import hardhat, { ethers } from 'hardhat';
import { toSqrtPrice, fromSqrtPrice, maxSqrtPrice, minSqrtPrice, ZERO_ADDR } from '../FixedPoint';
import { solidity } from "ethereum-waffle";
import chai from "chai";
import { MockERC20 } from '../../typechain/MockERC20';
import { BigNumber, ContractFactory, Signer } from 'ethers';
import { HotProxy, AltheaDexIncentivesContinuousEpochMulti } from '../../typechain';

chai.use(solidity);

describe("AltheaDexIncentivesContinuousEpochMulti - Delegated Registration", () => {
    let test1: TestPool;
    let incentives: AltheaDexIncentivesContinuousEpochMulti;
    let rewardToken: ERC20Token;
    let poolId: string;
    let user: Signer;
    let userAddress: string;
    let bot: Signer;
    let botAddress: string;
    let trader: Signer;
    let traderAddress: string;

    beforeEach("deploy and setup", async () => {
        [test1] = await makeTokenTriangle();
        rewardToken = await makeStandaloneToken();

        await test1.initPool(225 * 100, 0, 1, 1.5);
        test1.useHotPath = true;

        // Get signers
        const signers = await ethers.getSigners();
        trader = await test1.trader;
        user = signers[1];
        bot = signers[2];
        traderAddress = await trader.getAddress();
        userAddress = await user.getAddress();
        botAddress = await bot.getAddress();

        await test1.base.approve(trader, (await test1.dex).address, ethers.constants.MaxUint256);
        await test1.quote.approve(trader, (await test1.dex).address, ethers.constants.MaxUint256);

        const incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        incentives = await incentivesFactory.deploy((await test1.dex).address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;

        poolId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [(await test1.base).address, (await test1.quote).address, POOL_IDX]
            )
        );
    });

    describe("Basic Delegated Registration Functionality", () => {
        it("Should allow a bot to register on behalf of a user", async () => {
            // User provides liquidity
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            // Create a reward program
            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);

            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(trader, await incentives.address, fundingAmount);

            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Bot registers on behalf of user (delegated registration)
            await incentives.connect(bot).register(traderAddress, poolId, rewardToken.address, true);

            // Verify user is registered
            const userInfo = await incentives.userConcRewardInfo(traderAddress, poolId, rewardToken.address);
            expect(userInfo.registered).to.be.true;

            // Wait for blocks
            await hardhat.network.provider.send("hardhat_mine", ["0xA"]); // 10 blocks

            // User should be able to claim rewards
            const pendingRewards = await incentives.getPendingRewards(traderAddress, poolId, rewardToken.address, true);
            expect(pendingRewards).to.be.gt(0);

            const initialBalance = await rewardToken.balanceOf(traderAddress);
            await incentives.connect(trader).claimRewards(poolId, rewardToken.address, true);
            const finalBalance = await rewardToken.balanceOf(traderAddress);

            expect(finalBalance.sub(initialBalance)).to.be.gt(0);
        });

        it("Should allow user to self-register (backwards compatible)", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);

            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(trader, await incentives.address, fundingAmount);

            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // User self-registers (passing their own address)
            await incentives.connect(trader).register(traderAddress, poolId, rewardToken.address, true);

            const userInfo = await incentives.userConcRewardInfo(traderAddress, poolId, rewardToken.address);
            expect(userInfo.registered).to.be.true;
        });

        it("Should emit RegisteredForRewards event with correct user address in delegated registration", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);

            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(trader, await incentives.address, fundingAmount);

            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Bot registers on behalf of user - event should show user's address, not bot's
            const botAddress = await bot.getAddress();
            await expect(
                incentives.connect(bot).register(traderAddress, poolId, rewardToken.address, true)
            )
                .to.emit(incentives, "FirstRegistration")
                .withArgs(traderAddress, poolId, rewardToken.address, true, botAddress)
                .to.emit(incentives, "Registration")
                .withArgs(traderAddress, poolId, rewardToken.address, true, botAddress);
        });

        it("Should prevent registering zero address", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);

            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(trader, await incentives.address, fundingAmount);

            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            await expect(
                incentives.register(ethers.constants.AddressZero, poolId, rewardToken.address, true)
            ).to.be.revertedWith("Invalid user address");
        });
    });

    describe("Delegated Re-registration", () => {
        it("Should allow bot to re-register user after liquidity change", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);

            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(trader, await incentives.address, fundingAmount);

            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Initial registration by bot
            await incentives.connect(bot).register(traderAddress, poolId, rewardToken.address, true);

            // Wait and accumulate some rewards
            await hardhat.network.provider.send("hardhat_mine", ["0x5"]); // 5 blocks

            // User modifies liquidity
            await test1.testMint(-5000, 8000, liq.mul(2));

            // Bot re-registers on behalf of user
            const botAddress = await bot.getAddress();
            await expect(
                incentives.connect(bot).register(traderAddress, poolId, rewardToken.address, true)
            )
                .to.emit(incentives, "Registration")
                .withArgs(traderAddress, poolId, rewardToken.address, true, botAddress);

            // Verify user is still registered with new liquidity
            const userInfo = await incentives.userConcRewardInfo(traderAddress, poolId, rewardToken.address);
            expect(userInfo.registered).to.be.true;
        });
    });

    describe("Combined Delegated Registration and Claiming", () => {
        it("Should support full automated UX: bot registers and claims for user", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const rewardPerBlock = ethers.utils.parseUnits("10", 18);
            const fundingAmount = ethers.utils.parseUnits("1000", 18);

            await rewardToken.contract.deposit(traderAddress, fundingAmount);
            await rewardToken.approve(trader, await incentives.address, fundingAmount);

            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                rewardPerBlock,
                fundingAmount,
                true
            );

            // Step 1: Bot registers user
            await incentives.connect(bot).register(traderAddress, poolId, rewardToken.address, true);

            // Step 2: Time passes
            await hardhat.network.provider.send("hardhat_mine", ["0x14"]); // 20 blocks

            // Step 3: Bot claims rewards on behalf of user
            const userBalanceBefore = await rewardToken.balanceOf(traderAddress);
            const botBalanceBefore = await rewardToken.balanceOf(botAddress);

            await incentives.connect(bot).claimRewardsOnBehalfOf(traderAddress, poolId, rewardToken.address, true);

            const userBalanceAfter = await rewardToken.balanceOf(traderAddress);
            const botBalanceAfter = await rewardToken.balanceOf(botAddress);

            // User receives 99% of rewards
            const userGain = userBalanceAfter.sub(userBalanceBefore);
            expect(userGain).to.be.gt(0);

            // Bot receives 1% of rewards as fee
            const botGain = botBalanceAfter.sub(botBalanceBefore);
            expect(botGain).to.be.gt(0);

            // Verify the ratio is approximately 99:1
            const totalRewards = userGain.add(botGain);
            const userPercentage = userGain.mul(10000).div(totalRewards).toNumber();
            expect(userPercentage).to.be.closeTo(9900, 10); // 99% with small tolerance

            console.log("\n✅ Fully automated UX demonstration:");
            console.log(`   User deposited liquidity: ${liq.toString()}`);
            console.log(`   Bot registered user automatically`);
            console.log(`   20 blocks passed`);
            console.log(`   Bot claimed rewards automatically`);
            console.log(`   User received: ${ethers.utils.formatUnits(userGain, 18)} tokens (99%)`);
            console.log(`   Bot received: ${ethers.utils.formatUnits(botGain, 18)} tokens (1% fee)`);
            console.log(`   User took NO action but received rewards in wallet! ✨`);
        });
    });
});
