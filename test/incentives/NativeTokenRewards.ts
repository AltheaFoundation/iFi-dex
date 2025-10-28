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

describe('NativeTokenRewards - Per-Block Incentives', () => {
    let test1: TestPool
    let test2: TestPool
    let test3: TestPool
    let baseToken: ERC20Token
    let quoteToken: ERC20Token
    const feeRate = 225 * 100
    let incentives : AltheaDexIncentivesContinuousEpochMulti
    let baseQuotePoolId: string

    beforeEach("deploy",  async () => {
        [test1, test2, test3] = await makeTokenTriangle()
        baseToken = await test1.base
        quoteToken = await test1.quote

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

    it("concentrated: native token rewards work correctly", async () => {
        const liq = 1000000;
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseEther("0.01"); // 0.01 ETH per block
        const fundingAmount = ethers.utils.parseEther("10"); // 1000 blocks
        
        // Use address(0) for native token - send value with the transaction
        await incentives.createOrModifyProgram(baseQuotePoolId, ZERO_ADDR, rewardPerBlock, fundingAmount, true,
            { value: fundingAmount }
        );

        await incentives.register(baseQuotePoolId, ZERO_ADDR, true);

        // Wait for 10 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        const traderAddress = await (await test1.trader).getAddress();
        const initialBalance = await ethers.provider.getBalance(traderAddress);

        const tx = await incentives.claimRewards(baseQuotePoolId, ZERO_ADDR, true);
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed.mul(receipt.effectiveGasPrice);

        const finalBalance = await ethers.provider.getBalance(traderAddress);
        
        // Account for gas cost - expect ~10 blocks worth of rewards
        const netGain = finalBalance.add(gasUsed).sub(initialBalance);
        expect(netGain).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseEther("0.01"));
    });

    it("ambient: native token rewards work correctly", async () => {
        const liq = 1000000;
        await test1.testMintAmbient(liq); 

        const rewardPerBlock = ethers.utils.parseEther("0.01"); // 0.01 ETH per block
        const fundingAmount = ethers.utils.parseEther("10"); // 1000 blocks
        
        await incentives.createOrModifyProgram(baseQuotePoolId, ZERO_ADDR, rewardPerBlock, fundingAmount, false,
            { value: fundingAmount }
        );

        await incentives.register(baseQuotePoolId, ZERO_ADDR, false);

        // Wait for 10 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        const traderAddress = await (await test1.trader).getAddress();
        const initialBalance = await ethers.provider.getBalance(traderAddress);

        const tx = await incentives.claimRewards(baseQuotePoolId, ZERO_ADDR, false);
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed.mul(receipt.effectiveGasPrice);

        const finalBalance = await ethers.provider.getBalance(traderAddress);
        
        // Account for gas cost - expect ~10 blocks worth of rewards
        const netGain = finalBalance.add(gasUsed).sub(initialBalance);
        expect(netGain).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseEther("0.01"));
    });

    it("concentrated: ERC20 token rewards work correctly", async () => {
        const rewardToken = await makeStandaloneToken();
        const liq = 1000000;
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("1000", 18); // 100 blocks
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount, true);

        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        // Wait for 10 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        const initialBalance = await rewardToken.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

        const finalBalance = await rewardToken.balanceOf(traderAddress);
        
        // Expect ~10 blocks worth of rewards
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 18));
    });

    it("ambient: ERC20 token rewards work correctly", async () => {
        const rewardToken = await makeStandaloneToken();
        const liq = 1000000;
        await test1.testMintAmbient(liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("1000", 18); // 100 blocks
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount, false);

        await incentives.register(baseQuotePoolId, rewardToken.address, false);

        // Wait for 10 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        const initialBalance = await rewardToken.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, false);

        const finalBalance = await rewardToken.balanceOf(traderAddress);
        
        // Expect ~10 blocks worth of rewards
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 18));
    });
});
