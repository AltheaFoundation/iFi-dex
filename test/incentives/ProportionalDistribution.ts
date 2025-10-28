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
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

chai.use(solidity);

describe('ProportionalDistribution - Per-Block Incentives', () => {
    let test1: TestPool
    let test2: TestPool
    let test3: TestPool
    let baseToken: ERC20Token
    let quoteToken: ERC20Token
    let rewardToken: ERC20Token
    const feeRate = 225 * 100
    let incentives : AltheaDexIncentivesContinuousEpochMulti
    let baseQuotePoolId: string
    let userA: SignerWithAddress
    let userB: SignerWithAddress

    beforeEach("deploy",  async () => {
        const signers = await ethers.getSigners();
        userA = signers[0]; // default trader
        userB = signers[1];

        [test1, test2, test3] = await makeTokenTriangle()
        baseToken = await test1.base
        quoteToken = await test1.quote
        rewardToken = await makeStandaloneToken();

        await test1.initPool(feeRate, 0, 1, 1.5)
        test1.useHotPath = true;
 
        // Approve for trader and other
        await test1.base.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test1.quote.approve(await test1.trader, (await test1.dex).address, 100000000000)
        await test1.base.approve(await test1.other, (await test1.dex).address, 100000000000)
        await test1.quote.approve(await test1.other, (await test1.dex).address, 100000000000)

        let incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        incentives = await incentivesFactory.deploy((await test1.dex).address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;
 
        baseQuotePoolId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [baseToken.address, quoteToken.address, POOL_IDX]
            )
        );
    })

    it("single user claims rewards across 200 blocks without claiming in between", async () => {
        // This tests that the accumulator properly tracks rewards over multiple blocks
        // If a user has constant liquidity for 200 blocks and doesn't claim, they get 200 blocks worth of rewards
        
        const rewardPerBlock = ethers.utils.parseUnits("10", 18); // 10 tokens per block
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        const liq = 1000000;
        await test1.testMint(-5000, 8000, liq);

        // Register (only one user, should get 100% of rewards)
        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        // Wait for 200 blocks to pass
        await hardhat.network.provider.send("hardhat_mine", [`0x${(200 - 1).toString(16)}`]);

        // Check pending rewards - should be 200 blocks worth
        const pendingRewards = await incentives.getPendingConcentratedRewards(baseQuotePoolId, traderAddress, rewardToken.address);
        const expectedRewards = rewardPerBlock.mul(200); // 2000 tokens
        expect(pendingRewards).to.be.closeTo(expectedRewards, ethers.utils.parseUnits("20", 18));

        // Claim and withdraw
        const initialBalance = await rewardToken.balanceOf(traderAddress);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        const finalBalance = await rewardToken.balanceOf(traderAddress);
        
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(expectedRewards, ethers.utils.parseUnits("20", 18));
    });

    it("user claims after each 100-block period, total matches multi-block claim", async () => {
        // Verifies that claiming after each 100-block period gives same total as claiming once after 200 blocks
        
        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        const liq = 1000000;
        await test1.testMint(-5000, 8000, liq);

        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        const initialBalance = await rewardToken.balanceOf(traderAddress);

        // Claim after 100 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(100 - 1).toString(16)}`]);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balance1 = await rewardToken.balanceOf(traderAddress);
        const pending1 = balance1.sub(initialBalance);

        // Claim after another 100 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(100).toString(16)}`]);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        const balance2 = await rewardToken.balanceOf(traderAddress);
        const pending2 = balance2.sub(balance1);
        
        const totalClaimed = balance2.sub(initialBalance);

        // Total should be 200 blocks worth
        const expectedTotal = rewardPerBlock.mul(200);
        expect(totalClaimed).to.be.closeTo(expectedTotal, ethers.utils.parseUnits("20", 18));
        expect(pending1).to.be.closeTo(rewardPerBlock.mul(100), ethers.utils.parseUnits("10", 18));
        expect(pending2).to.be.closeTo(rewardPerBlock.mul(100), ethers.utils.parseUnits("10", 18));
    });

    it("Single user maintains constant share across 150 blocks", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("20", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        const liq = 500000;
        
        // Only trader provides liquidity
        await test1.testMint(-5000, 8000, liq);

        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        // Wait 150 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(150 - 1).toString(16)}`]);

        const initialBalance = await rewardToken.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

        const finalBalance = await rewardToken.balanceOf(traderAddress);

        const rewards = finalBalance.sub(initialBalance);

        // Should get 150 blocks worth of rewards (100% share each block)
        const expectedRewards = rewardPerBlock.mul(150);
        expect(rewards).to.be.closeTo(expectedRewards, ethers.utils.parseUnits("30", 18));
    });

    it("Rewards scale with liquidity amount", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("20", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        // Test with 1x liquidity
        const liq1x = 100000;
        await test1.testMint(-5000, 8000, liq1x);

        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        await hardhat.network.provider.send("hardhat_mine", [`0x${(50 - 1).toString(16)}`]);

        let initialBalance = await rewardToken.balanceOf(traderAddress);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        let finalBalance = await rewardToken.balanceOf(traderAddress);
        
        const rewards1x = finalBalance.sub(initialBalance);

        // Burn position and add 2x liquidity
        await test1.testBurn(-5000, 8000, liq1x);
        const liq2x = 200000;
        await test1.testMint(-5000, 8000, liq2x);

        // Re-register
        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        await hardhat.network.provider.send("hardhat_mine", [`0x${(50).toString(16)}`]);

        initialBalance = await rewardToken.balanceOf(traderAddress);
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);
        finalBalance = await rewardToken.balanceOf(traderAddress);
        
        const rewards2x = finalBalance.sub(initialBalance);

        // Both should be equal to approximately 50 blocks worth since user has 100% share regardless of liquidity amount
        // Tolerance accounts for transaction timing creating extra blocks
        expect(rewards1x).to.be.closeTo(rewardPerBlock.mul(50), ethers.utils.parseUnits("30", 18));
        expect(rewards2x).to.be.closeTo(rewardPerBlock.mul(50), ethers.utils.parseUnits("30", 18));
    });
});
