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

describe("AltheaDexIncentives - Epoch System", function () {
    let test1: TestPool;
    let test2: TestPool;
    let test3: TestPool;
    let baseToken: ERC20Token;
    let quoteToken: ERC20Token;
    let rewardToken: ERC20Token;
    const feeRate = 225 * 100;
    let incentives: AltheaDexIncentivesContinuousEpochMulti;
    let baseQuotePoolId: string;
    
    const REWARD_PER_BLOCK = BigNumber.from("100000000000000000000"); // 100 tokens per block
    const INITIAL_FUNDING = BigNumber.from("10000000000000000000000"); // 10000 tokens
    
    beforeEach("deploy", async () => {
        [test1, test2, test3] = await makeTokenTriangle();
        baseToken = await test1.base;
        quoteToken = await test1.quote;
        rewardToken = await makeStandaloneToken();

        await test1.initPool(feeRate, 0, 1, 1.5);
        await test2.initPool(feeRate, 0, 1, 1.5);
        test1.useHotPath = true;
        test2.useHotPath = true;
 
        await test1.base.approve(await test1.trader, (await test1.dex).address, 100000000000);
        await test1.quote.approve(await test1.trader, (await test1.dex).address, 100000000000);
        await test2.base.approve(await test1.trader, (await test1.dex).address, 100000000000);
        await test2.quote.approve(await test1.trader, (await test1.dex).address, 100000000000);

        let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        incentives = await incentivesFactory.deploy((await test1.dex).address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;
 
        baseQuotePoolId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [baseToken.address, quoteToken.address, POOL_IDX]
            )
        );
    });
    
    describe("Epoch initialization", function () {
        it("Should start with epoch 1 on program creation", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, INITIAL_FUNDING);
            await rewardToken.approve(await test1.trader, await incentives.address, INITIAL_FUNDING);
            
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            const program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            expect(program.epoch).to.equal(1);
        });
        
        it("Should increment epoch when reactivating a deactivated program", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, INITIAL_FUNDING.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
            
            // Create program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            let program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            expect(program.epoch).to.equal(1);
            
            // Deactivate program
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            
            // Reactivate program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            expect(program.epoch).to.equal(2);
        });
        
        it("Should emit ProgramEpochIncremented event on reactivation", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, INITIAL_FUNDING.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
            
            // Create program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            // Deactivate program
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            
            // Reactivate program - should emit epoch incremented event
            await expect(
                incentives.createOrModifyProgram(
                    baseQuotePoolId,
                    rewardToken.address,
                    REWARD_PER_BLOCK,
                    INITIAL_FUNDING,
                    true
                )
            ).to.emit(incentives, "ProgramEpochIncremented")
             .withArgs(baseQuotePoolId, rewardToken.address, true, 2);
        });
        
        it("Should NOT increment epoch when modifying active program", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, INITIAL_FUNDING.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
            
            // Create program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            let program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            expect(program.epoch).to.equal(1);
            
            // Modify active program (add more funding)
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            expect(program.epoch).to.equal(1); // Should still be 1
        });
        
        it("Should reset accumulator and registered liquidity on epoch increment", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, INITIAL_FUNDING.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
            
            // Create program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            // Add concentrated liquidity and register
            await test1.testMint(-100, 100, 10000);
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            let program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            expect(program.totalRegisteredLiquidity).to.be.gt(0);
            
            // Mine some blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x2"]);
            
            // Deactivate and reactivate
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, true);
            expect(program.epoch).to.equal(2);
            expect(program.rewardPerLiquidityAccumulator).to.equal(0); // Reset
            expect(program.totalRegisteredLiquidity).to.equal(0); // Reset
        });
    });
    
    describe("User registration with epochs", function () {
        beforeEach(async function () {
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, INITIAL_FUNDING.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
            
            // Create initial program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            // Add liquidity for user
            await test1.testMint(-100, 100, 10000);
        });
        
        it("Should register user with current epoch", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            const userInfo = await incentives.userConcRewardInfo(
                traderAddress,
                baseQuotePoolId,
                rewardToken.address
            );
            expect(userInfo.epoch).to.equal(1);
            expect(userInfo.registered).to.be.true;
        });
        
        it("Should allow user to re-register after epoch increment", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            
            // User registers in epoch 1
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            let userInfo = await incentives.userConcRewardInfo(traderAddress, baseQuotePoolId, rewardToken.address);
            expect(userInfo.epoch).to.equal(1);
            
            // Deactivate and reactivate program
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            // User re-registers in epoch 2
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            userInfo = await incentives.userConcRewardInfo(traderAddress, baseQuotePoolId, rewardToken.address);
            expect(userInfo.epoch).to.equal(2);
            expect(userInfo.registered).to.be.true;
        });
        
        it("Should emit UserReregistered event when user re-registers for new epoch", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            
            // User registers in epoch 1
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Deactivate and reactivate program
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            // User re-registers - should emit UserReregistered event
            await expect(
                incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true)
            ).to.emit(incentives, "UserReregistered")
             .withArgs(traderAddress, baseQuotePoolId, rewardToken.address, true);
        });
    });
    
    describe("Claiming with epochs", function () {
        beforeEach(async function () {
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, INITIAL_FUNDING.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
            
            // Create initial program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            // Add liquidity for user
            await test1.testMint(-100, 100, 10000);
        });
        
        it("Should allow user to claim if registered in current epoch", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            
            // User registers in epoch 1
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Mine some blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x2"]);
            
            // User should be able to claim
            const pendingRewards = await incentives.getPendingRewards(
                baseQuotePoolId,
                traderAddress,
                rewardToken.address,
                true
            );
            expect(pendingRewards).to.be.gt(0);
            
            await expect(
                incentives.claimRewards(baseQuotePoolId, rewardToken.address, true)
            ).to.emit(incentives, "ClaimedRewards");
        });
        
        it("Should prevent user from claiming if registered in old epoch", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            
            // User registers in epoch 1
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Mine some blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x2"]);
            
            // Deactivate and reactivate program (epoch 2)
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            // User should not be able to claim (wrong epoch)
            await expect(
                incentives.claimRewards(baseQuotePoolId, rewardToken.address, true)
            ).to.be.revertedWith("User registered in old epoch, must re-register");
        });
        
        it("Should return 0 pending rewards for user in old epoch", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            
            // User registers in epoch 1
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Mine some blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x2"]);
            
            // Deactivate and reactivate program (epoch 2)
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            // Pending rewards should be 0 (old epoch)
            const pendingRewards = await incentives.getPendingRewards(
                baseQuotePoolId,
                traderAddress,
                rewardToken.address,
                true
            );
            expect(pendingRewards).to.equal(0);
        });
        
        it("Should allow user to claim after re-registering in new epoch", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            
            // User registers in epoch 1
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Mine some blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x2"]);
            
            // Deactivate and reactivate program (epoch 2)
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                true
            );
            
            // User re-registers in epoch 2
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);
            
            // Mine some blocks
            await hardhat.network.provider.send("hardhat_mine", ["0x2"]);
            
            // User should be able to claim new epoch rewards
            const pendingRewards = await incentives.getPendingRewards(
                baseQuotePoolId,
                traderAddress,
                rewardToken.address,
                true
            );
            expect(pendingRewards).to.be.gt(0);
            
            await expect(
                incentives.claimRewards(baseQuotePoolId, rewardToken.address, true)
            ).to.emit(incentives, "ClaimedRewards");
        });
    });
    
    describe("Ambient liquidity epochs", function () {
        beforeEach(async function () {
            const traderAddress = await (await test1.trader).getAddress();
            await rewardToken.contract.deposit(traderAddress, INITIAL_FUNDING.mul(2));
            await rewardToken.approve(await test1.trader, await incentives.address, ethers.constants.MaxUint256);
            
            // Create ambient program
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                false // Ambient
            );
            
            // Add ambient liquidity
            await test1.testMintAmbient(10000);
        });
        
        it("Should handle epochs for ambient liquidity programs", async function () {
            const traderAddress = await (await test1.trader).getAddress();
            
            // User registers in epoch 1
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);
            
            let userInfo = await incentives.userAmbRewardInfo(traderAddress, baseQuotePoolId, rewardToken.address);
            expect(userInfo.epoch).to.equal(1);
            
            // Deactivate and reactivate
            await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, false);
            await incentives.createOrModifyProgram(
                baseQuotePoolId,
                rewardToken.address,
                REWARD_PER_BLOCK,
                INITIAL_FUNDING,
                false
            );
            
            const program = await incentives.getProgramInfo(baseQuotePoolId, rewardToken.address, false);
            expect(program.epoch).to.equal(2);
            
            // User must re-register
            await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);
            userInfo = await incentives.userAmbRewardInfo(traderAddress, baseQuotePoolId, rewardToken.address);
            expect(userInfo.epoch).to.equal(2);
        });
    });
});
