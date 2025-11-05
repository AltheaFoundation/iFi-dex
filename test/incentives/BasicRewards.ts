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

describe('BasicRewards - Per-Block Incentives', () => {
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

    it("concentrated: mint, register, wait blocks, claim rewards", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18); // 10 tokens per block
        const blocksToWait = 10; // wait 10 blocks
        const fundingAmount = ethers.utils.parseUnits("1000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Deposit tokens to trader, then approve and fund the program
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(
            baseQuotePoolId, 
            rewardToken.address, 
            rewardPerBlock,  
            fundingAmount,
            true // concentrated
        );

        // Register for rewards
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

        // Wait for blocks - user gets rewards for these blocks
        // Note: We mine blocksToWait-1 because the claim transaction itself creates one more block
        await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);

        // Check pending rewards
        const pendingRewards = await incentives.getPendingRewards(traderAddress, baseQuotePoolId, rewardToken.address, true);
        expect(pendingRewards).to.be.gt(0);

        const initialBalance = await rewardToken.balanceOf(traderAddress);

        // Claim and withdraw (this transaction mines one more block, completing the blocksToWait)
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

        const finalBalance = await rewardToken.balanceOf(traderAddress);
        
        // User should get all rewards since they're the only LP
        expect(finalBalance.sub(initialBalance)).to.equal(rewardPerBlock.mul(blocksToWait));
    });

    it("ambient: mint, register, wait blocks, claim rewards", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMintAmbient(liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18); // 10 tokens per block
        const blocksToWait = 10; // wait 10 blocks
        const fundingAmount = ethers.utils.parseUnits("1000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Deposit tokens to trader, then approve and fund the program
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(
            baseQuotePoolId, 
            rewardToken.address, 
            rewardPerBlock,  
            fundingAmount,
            false // ambient
        );

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, false);

        // Wait for blocks to accumulate rewards
        // Note: We mine blocksToWait-1 because the claim transaction itself creates one more block
        await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);

        const pendingRewards = await incentives.getPendingRewards(traderAddress, baseQuotePoolId, rewardToken.address, false);
        expect(pendingRewards).to.be.gt(0);

        const initialBalance = await rewardToken.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, false);

        const finalBalance = await rewardToken.balanceOf(traderAddress);
        
        expect(finalBalance.sub(initialBalance)).to.equal(rewardPerBlock.mul(blocksToWait));
    });

    it("concentrated: cannot register without liquidity", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("1000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Deposit tokens to trader, then approve and fund the program
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(
            baseQuotePoolId, 
            rewardToken.address, 
            rewardPerBlock,  
            fundingAmount,
            true // concentrated
        );

        await expect(
            incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true)
        ).to.be.revertedWith("No net liquidity");
    });

    it("concentrated: cannot claim if liquidity changed", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const blocksToWait = 10;
        const fundingAmount = ethers.utils.parseUnits("1000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Deposit tokens to trader, then approve and fund the program
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(
            baseQuotePoolId, 
            rewardToken.address, 
            rewardPerBlock,  
            fundingAmount,
            true // concentrated
        );

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

        // Add more liquidity (changes the accumulator)
        await test1.testMint(-5000, 8000, liq);

        await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToWait.toString(16)}`]);

        // Should fail because liquidity changed
        await expect(
            incentives.claimRewards(baseQuotePoolId, rewardToken.address, true)
        ).to.be.revertedWith("Liquidity changed");
    });

    it("concentrated: claim gets rewards immediately", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const blocksToWait = 10;
        const fundingAmount = ethers.utils.parseUnits("1000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Deposit tokens to trader, then approve and fund the program
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(
            baseQuotePoolId, 
            rewardToken.address, 
            rewardPerBlock,  
            fundingAmount,
            true // concentrated
        );

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken.address, true);

        // Note: We mine blocksToWait-1 because the claim transaction itself creates one more block
        await hardhat.network.provider.send("hardhat_mine", [`0x${(blocksToWait - 1).toString(16)}`]);

        const initialBalance = await rewardToken.balanceOf(traderAddress);

        // Claim transfers rewards immediately
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

        const finalBalance = await rewardToken.balanceOf(traderAddress);
        
        expect(finalBalance.sub(initialBalance)).to.equal(rewardPerBlock.mul(blocksToWait));
    });
});
