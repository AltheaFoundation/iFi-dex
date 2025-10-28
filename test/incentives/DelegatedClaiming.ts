import { TestPool, makeTokenPool, POOL_IDX, ERC20Token, makeStandaloneToken, makeTokenTriangle } from '../FacadePool';
import { expect } from "chai";
import hardhat, { ethers } from "hardhat";
import { BigNumber } from "ethers";
import { AltheaDexIncentivesContinuousEpochMulti } from "../../typechain";
import { ZERO_ADDR } from '../FixedPoint';

describe("AltheaDexIncentivesContinuousEpochMulti - Delegated Claiming", function () {
    let test1: TestPool;
    let test2: TestPool;
    let test3: TestPool;
    let incentives: AltheaDexIncentivesContinuousEpochMulti;
    let rewardToken: ERC20Token;
    let poolId: string;

    const REWARD_PER_BLOCK = ethers.utils.parseEther("10");
    const INITIAL_FUNDING = ethers.utils.parseEther("10000");
    const DEFAULT_FEE_BASIS_POINTS = 100; // 1%
    const BASIS_POINTS = 10000;
    const feeRate = 225 * 100;

    beforeEach(async function () {
        [test1, test2, test3] = await makeTokenTriangle();
        
        await test1.initPool(feeRate, 0, 1, 1.5);
        await test2.initPool(feeRate, 0, 1, 1.5);
        test1.useHotPath = true;
        test2.useHotPath = true;

        const trader = await test1.trader;
        const traderAddress = await trader.getAddress();

        // Setup approvals
        await test1.base.approve(trader, (await test1.dex).address, ethers.constants.MaxUint256);
        await test1.quote.approve(trader, (await test1.dex).address, ethers.constants.MaxUint256);

        // Deploy incentives contract
        const IncentivesFactory = await ethers.getContractFactory(
            "AltheaDexIncentivesContinuousEpochMulti"
        );
        incentives = await IncentivesFactory.deploy(
            (await test1.dex).address,
            ZERO_ADDR
        ) as AltheaDexIncentivesContinuousEpochMulti;
        await incentives.deployed();

        // Create reward token
        rewardToken = await makeStandaloneToken();

        // Fund the trader with reward tokens and approve
        await rewardToken.contract.deposit(traderAddress, INITIAL_FUNDING.mul(10));
        await rewardToken.approve(trader, incentives.address, ethers.constants.MaxUint256);

        // Calculate pool ID
        poolId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [test1.base.address, test1.quote.address, POOL_IDX]
            )
        );
    });

    describe("Basic Delegated Claim Functionality", function () {
        it("Should allow third party to claim on behalf of user and split rewards correctly", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const trader = await test1.trader;
            const traderAddress = await trader.getAddress();

            // Create and fund reward program
            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );

            // Register for rewards
            await incentives.register(poolId, rewardToken.address, true);

            // Wait for blocks
            const blocksToWait = 100;
            await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToWait.toString(16)}`]);

            // Get claimer (different signer)
            const signers = await ethers.getSigners();
            const claimer = signers[2];
            const claimerAddress = await claimer.getAddress();

            const userBalanceBefore = await rewardToken.balanceOf(traderAddress);
            const claimerBalanceBefore = await rewardToken.balanceOf(claimerAddress);

            // Claimer claims on behalf of user
            await expect(
                incentives
                    .connect(claimer)
                    .claimRewardsOnBehalfOf(traderAddress, poolId, rewardToken.address, true)
            ).to.emit(incentives, "DelegatedClaimRewards");

            const userBalanceAfter = await rewardToken.balanceOf(traderAddress);
            const claimerBalanceAfter = await rewardToken.balanceOf(claimerAddress);

            const userRewards = userBalanceAfter.sub(userBalanceBefore);
            const claimerFee = claimerBalanceAfter.sub(claimerBalanceBefore);

            // Verify total rewards distributed
            const totalRewards = userRewards.add(claimerFee);
            expect(totalRewards).to.be.gt(0);

            // Verify fee split (1% to claimer, 99% to user)
            const expectedClaimerFee = totalRewards.mul(DEFAULT_FEE_BASIS_POINTS).div(BASIS_POINTS);
            expect(claimerFee).to.equal(expectedClaimerFee);
            expect(userRewards).to.equal(totalRewards.sub(expectedClaimerFee));
        });

        it("Should emit correct event for delegated claim", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const trader = await test1.trader;
            const traderAddress = await trader.getAddress();

            // Create and fund reward program
            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );

            // Register for rewards
            await incentives.register(poolId, rewardToken.address, true);

            // Wait for blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x64"]); // 100 blocks

            // Get claimer
            const signers = await ethers.getSigners();
            const claimer = signers[2];
            const claimerAddress = await claimer.getAddress();

            // Claimer claims on behalf of user - check that event is emitted
            // Note: We don't check exact values due to extra block mined by the transaction
            await expect(
                incentives
                    .connect(claimer)
                    .claimRewardsOnBehalfOf(traderAddress, poolId, rewardToken.address, true)
            ).to.emit(incentives, "DelegatedClaimRewards")
                .withArgs(
                    claimerAddress,
                    traderAddress,
                    poolId,
                    rewardToken.address,
                    true,
                    (userAmount: any) => userAmount.gt(0),  // Just check it's positive
                    (claimerFee: any) => claimerFee.gt(0)  // Just check it's positive
                );
        });

        it("Should not allow self-delegated claim", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const trader = await test1.trader;
            const traderAddress = await trader.getAddress();

            // Create and fund reward program
            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );

            // Register for rewards
            await incentives.register(poolId, rewardToken.address, true);

            // Wait for blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x64"]);

            // User tries to claim on behalf of themselves (should fail)
            await expect(
                incentives.claimRewardsOnBehalfOf(traderAddress, poolId, rewardToken.address, true)
            ).to.be.revertedWith("Use claimRewards for self-claim");
        });

        it("Should allow user to claim normally after delegated claim", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const trader = await test1.trader;
            const traderAddress = await trader.getAddress();

            // Create and fund reward program
            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );

            // Register for rewards
            await incentives.register(poolId, rewardToken.address, true);

            // Wait for blocks and delegated claim
            await hardhat.network.provider.send("hardhat_mine", ["0x64"]);

            const signers = await ethers.getSigners();
            const claimer = signers[2];

            await incentives
                .connect(claimer)
                .claimRewardsOnBehalfOf(traderAddress, poolId, rewardToken.address, true);

            // Wait for more blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x64"]);

            const userBalanceBefore = await rewardToken.balanceOf(traderAddress);

            // User claims normally
            await expect(
                incentives.claimRewards(poolId, rewardToken.address, true)
            ).to.emit(incentives, "ClaimedRewards");

            const userBalanceAfter = await rewardToken.balanceOf(traderAddress);
            expect(userBalanceAfter).to.be.gt(userBalanceBefore);
        });
    });

    describe("Fee Management", function () {
        it("Should allow owner to update delegated claim fee", async () => {
            const newFee = 200; // 2%

            await expect(incentives.updateDelegatedClaimFee(newFee))
                .to.emit(incentives, "DelegatedClaimFeeUpdated")
                .withArgs(DEFAULT_FEE_BASIS_POINTS, newFee);

            expect(await incentives.DELEGATED_CLAIM_FEE_BASIS_POINTS()).to.equal(newFee);
        });

        it("Should reject fee update greater than 100%", async () => {
            const invalidFee = 10001; // > 100%

            await expect(
                incentives.updateDelegatedClaimFee(invalidFee)
            ).to.be.revertedWith("Fee exceeds 100%");
        });

        it("Should apply updated fee to subsequent delegated claims", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const trader = await test1.trader;
            const traderAddress = await trader.getAddress();

            // Create and fund reward program
            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );

            // Register for rewards
            await incentives.register(poolId, rewardToken.address, true);

            // Update fee to 2%
            const newFee = 200;
            await incentives.updateDelegatedClaimFee(newFee);

            // Wait for blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x64"]);

            const signers = await ethers.getSigners();
            const claimer = signers[2];
            const claimerAddress = await claimer.getAddress();

            const userBalanceBefore = await rewardToken.balanceOf(traderAddress);
            const claimerBalanceBefore = await rewardToken.balanceOf(claimerAddress);

            // Delegated claim
            await incentives
                .connect(claimer)
                .claimRewardsOnBehalfOf(traderAddress, poolId, rewardToken.address, true);

            const userBalanceAfter = await rewardToken.balanceOf(traderAddress);
            const claimerBalanceAfter = await rewardToken.balanceOf(claimerAddress);

            const userRewards = userBalanceAfter.sub(userBalanceBefore);
            const claimerFee = claimerBalanceAfter.sub(claimerBalanceBefore);

            // Verify fee split with new 2% fee
            const totalRewards = userRewards.add(claimerFee);
            const expectedClaimerFee = totalRewards.mul(newFee).div(BASIS_POINTS);
            expect(claimerFee).to.equal(expectedClaimerFee);
        });

        it("Should allow 0% fee (no claimer compensation)", async () => {
            await incentives.updateDelegatedClaimFee(0);

            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const trader = await test1.trader;
            const traderAddress = await trader.getAddress();

            // Create and fund reward program
            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );

            // Register for rewards
            await incentives.register(poolId, rewardToken.address, true);

            // Wait for blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x64"]);

            const signers = await ethers.getSigners();
            const claimer = signers[2];
            const claimerAddress = await claimer.getAddress();

            const claimerBalanceBefore = await rewardToken.balanceOf(claimerAddress);

            // Delegated claim
            await incentives
                .connect(claimer)
                .claimRewardsOnBehalfOf(traderAddress, poolId, rewardToken.address, true);

            const claimerBalanceAfter = await rewardToken.balanceOf(claimerAddress);
            const claimerFee = claimerBalanceAfter.sub(claimerBalanceBefore);

            // Claimer gets nothing
            expect(claimerFee).to.equal(0);
        });
    });

    describe("Comparison: Self Claim vs Delegated Claim", function () {
        it("User receives approximately 1% less with delegated claim vs self claim", async () => {
            const liq = BigNumber.from(1000000);
            await test1.testMint(-5000, 8000, liq);

            const trader = await test1.trader;
            const traderAddress = await trader.getAddress();

            // Create and fund reward program
            await incentives.createOrModifyProgram(
                poolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );

            // Register for rewards
            await incentives.register(poolId, rewardToken.address, true);

            // Wait for blocks and self-claim
            await hardhat.network.provider.send("hardhat_mine", ["0x64"]); // 100 blocks

            const balanceBeforeSelfClaim = await rewardToken.balanceOf(traderAddress);
            await incentives.claimRewards(poolId, rewardToken.address, true);
            const balanceAfterSelfClaim = await rewardToken.balanceOf(traderAddress);
            const selfClaimRewards = balanceAfterSelfClaim.sub(balanceBeforeSelfClaim);

            // Wait for more blocks and delegated claim
            await hardhat.network.provider.send("hardhat_mine", ["0x64"]); // 100 blocks

            const signers = await ethers.getSigners();
            const claimer = signers[3];

            const balanceBeforeDelegatedClaim = await rewardToken.balanceOf(traderAddress);
            await incentives
                .connect(claimer)
                .claimRewardsOnBehalfOf(traderAddress, poolId, rewardToken.address, true);
            const balanceAfterDelegatedClaim = await rewardToken.balanceOf(traderAddress);
            const delegatedClaimRewards = balanceAfterDelegatedClaim.sub(balanceBeforeDelegatedClaim);

            // Self claim should give approximately 1% more than delegated claim
            // (since delegated claim has 1% fee)
            // Both waited same number of blocks, so rewards should be equal before fees
            expect(selfClaimRewards).to.be.gt(delegatedClaimRewards);

            // Calculate the percentage difference
            const difference = selfClaimRewards.sub(delegatedClaimRewards);
            const percentageDiff = difference.mul(BASIS_POINTS).div(selfClaimRewards);
            
            // Should be approximately 1% (100 basis points), allow small tolerance for rounding
            expect(percentageDiff.toNumber()).to.be.closeTo(DEFAULT_FEE_BASIS_POINTS, 10);
        });
    });
});
