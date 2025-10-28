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

describe('AdminModifications - Per-Block Incentives', () => {
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

    it("owner can modify reward rate and it accumulates correctly", async () => {
        const liq = 1000000;
        await test1.testMint(-5000, 8000, liq); 

        const initialRewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18); // 1000 blocks
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, initialRewardPerBlock, fundingAmount
        , true);

        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        // Wait for 10 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        let initialBalance = await rewardToken.balanceOf(traderAddress);

        // Claim first period
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

        let finalBalance = await rewardToken.balanceOf(traderAddress);
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(
            initialRewardPerBlock.mul(10), 
            ethers.utils.parseUnits("20", 18)
        );

        // Modify reward rate to 20 tokens per block
        const newRewardPerBlock = ethers.utils.parseUnits("20", 18);
        const newFundingAmount = ethers.utils.parseUnits("10000", 18); // 500 more blocks
        await rewardToken.contract.deposit(traderAddress, newFundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, newFundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, newRewardPerBlock, newFundingAmount
        , true);

        // Wait for 10 more blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        initialBalance = await rewardToken.balanceOf(traderAddress);

        // Claim second period
        await incentives.claimRewards(baseQuotePoolId, rewardToken.address, true);

        finalBalance = await rewardToken.balanceOf(traderAddress);
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(
            newRewardPerBlock.mul(10), 
            ethers.utils.parseUnits("60", 18) // Higher tolerance for modified reward rate
        );
    });

    it("owner can deactivate program explicitly", async () => {
        const liq = 1000000;
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18); // 1000 blocks
        
        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
        , true);

        await incentives.register(baseQuotePoolId, rewardToken.address, true);

        // Deactivate
        await incentives.deactivateProgram(baseQuotePoolId, rewardToken.address, true);

        // Try to register again - should fail
        await expect(
            incentives.register(baseQuotePoolId, rewardToken.address, true)
        ).to.be.revertedWith("Program not active");
    });

    it("non-owner cannot modify program", async () => {
        const signers = await ethers.getSigners();
        const nonOwner = signers[1];

        const rewardPerBlock = ethers.utils.parseUnits("10", 18);
        const fundingAmount = ethers.utils.parseUnits("10000", 18);
        
        await expect(
            incentives.connect(nonOwner).createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true)
        ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("emergency withdraw works and is admin-only", async () => {
        const signers = await ethers.getSigners();
        const owner = signers[0];
        const nonOwner = signers[1];

        // Fund the contract
        await rewardToken.contract.deposit(await incentives.address, ethers.utils.parseUnits("1000", 18));

        // Non-owner cannot withdraw
        await expect(
            incentives.connect(nonOwner).emergencyWithdraw(
                rewardToken.address,
                owner.address,
                ethers.utils.parseUnits("100", 18)
            )
        ).to.be.revertedWith("Ownable: caller is not the owner");

        // Owner can withdraw
        const initialBalance = await rewardToken.balanceOf(owner.address);
        
        await incentives.emergencyWithdraw(
            rewardToken.address,
            owner.address,
            ethers.utils.parseUnits("500", 18)
        );

        const finalBalance = await rewardToken.balanceOf(owner.address);
        expect(finalBalance.sub(initialBalance)).to.equal(ethers.utils.parseUnits("500", 18));
    });

    it("emergency withdraw works for native tokens", async () => {
        const signers = await ethers.getSigners();
        const owner = signers[0];

        // Fund with native token
        await owner.sendTransaction({
            to: await incentives.address,
            value: ethers.utils.parseEther("1")
        });

        const destination = signers[2].address;
        const initialBalance = await ethers.provider.getBalance(destination);

        await incentives.emergencyWithdraw(
            ZERO_ADDR,
            destination,
            ethers.utils.parseEther("0.5")
        );

        const finalBalance = await ethers.provider.getBalance(destination);
        expect(finalBalance.sub(initialBalance)).to.equal(ethers.utils.parseEther("0.5"));
    });

    it("cannot set reward rate to zero", async () => {
        const rewardPerBlock = ethers.utils.parseUnits("0", 18); // Invalid: zero reward rate
        const fundingAmount = ethers.utils.parseUnits("10000", 18);

        const traderAddress = await (await test1.trader).getAddress();
        await rewardToken.contract.deposit(traderAddress, fundingAmount);
        await rewardToken.approve(await test1.trader, await incentives.address, fundingAmount);

        // Should revert with zero reward rate
        await expect(
            incentives.createOrModifyProgram(baseQuotePoolId, rewardToken.address, rewardPerBlock, fundingAmount
            , true)
        ).to.be.revertedWith("Zero reward per block");
    });
});
