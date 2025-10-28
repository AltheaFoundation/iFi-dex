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

describe('TokenDecimalVariations - Per-Block Incentives', () => {
    let test1: TestPool
    let test2: TestPool
    let test3: TestPool
    let baseToken: ERC20Token
    let quoteToken: ERC20Token
    let rewardToken6: ERC20Token  // 6 decimals (like USDC)
    let rewardToken8: ERC20Token  // 8 decimals (like WBTC)
    let rewardToken18: ERC20Token // 18 decimals (standard)
    const feeRate = 225 * 100
    let incentives : AltheaDexIncentivesContinuousEpochMulti
    let baseQuotePoolId: string

    beforeEach("deploy",  async () => {
        [test1, test2, test3] = await makeTokenTriangle()
        baseToken = await test1.base
        quoteToken = await test1.quote
        
        // Create reward tokens with different decimals
        let factory = await ethers.getContractFactory("MockERC20") as ContractFactory;
        
        rewardToken6 = new ERC20Token(await factory.deploy() as MockERC20);
        await rewardToken6.contract.setDecimals(6);
        await rewardToken6.contract.setSymbol("USDC");
        
        rewardToken8 = new ERC20Token(await factory.deploy() as MockERC20);
        await rewardToken8.contract.setDecimals(8);
        await rewardToken8.contract.setSymbol("WBTC");
        
        rewardToken18 = new ERC20Token(await factory.deploy() as MockERC20);
        await rewardToken18.contract.setDecimals(18);
        await rewardToken18.contract.setSymbol("STANDARD");

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

    it("concentrated: 6-decimal token (USDC) rewards work correctly", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("10", 6); // 10 USDC per block
        const fundingAmount = ethers.utils.parseUnits("1000", 6); // 1000 USDC total
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Deposit tokens to trader, then approve and fund the program
        await rewardToken6.contract.deposit(traderAddress, fundingAmount);
        await rewardToken6.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken6.address, rewardPerBlock, fundingAmount
        , true);

        // Register for rewards
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken6.address, true);

        // Wait for 10 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        // Check pending rewards - allow tolerance for transaction timing
        const pendingRewards = await incentives.getPendingRewards(baseQuotePoolId, traderAddress, rewardToken6.address, true);
        expect(pendingRewards).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 6));

        const initialBalance = await rewardToken6.balanceOf(traderAddress);

        // Claim and withdraw
        await incentives.claimRewards(baseQuotePoolId, rewardToken6.address, true);

        const finalBalance = await rewardToken6.balanceOf(traderAddress);
        
        // User should get all rewards since they're the only LP
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("20", 6));
        
        // Verify the actual amount is approximately 100 USDC (100 * 10^6)
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(BigNumber.from("100000000"), ethers.utils.parseUnits("20", 6));
    });

    it("concentrated: 8-decimal token (WBTC) rewards work correctly", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("0.05", 8); // 0.05 WBTC per block
        const fundingAmount = ethers.utils.parseUnits("5", 8); // 5 WBTC total
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Deposit tokens to trader, then approve and fund the program
        await rewardToken8.contract.deposit(traderAddress, fundingAmount);
        await rewardToken8.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken8.address, rewardPerBlock, fundingAmount
        , true);

        // Register for rewards
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken8.address, true);

        // Wait for 10 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        // Check pending rewards - allow tolerance for transaction timing
        const pendingRewards = await incentives.getPendingRewards(baseQuotePoolId, traderAddress, rewardToken8.address, true);
        expect(pendingRewards).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("0.1", 8));

        const initialBalance = await rewardToken8.balanceOf(traderAddress);

        // Claim and withdraw
        await incentives.claimRewards(baseQuotePoolId, rewardToken8.address, true);

        const finalBalance = await rewardToken8.balanceOf(traderAddress);
        
        // User should get all rewards since they're the only LP
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("0.1", 8));
        
        // Verify the actual amount is approximately 0.5 WBTC (50000000 satoshis)
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(BigNumber.from("50000000"), ethers.utils.parseUnits("0.1", 8));
    });

    it("ambient: 6-decimal token (USDC) rewards work correctly", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMintAmbient(liq); 

        const rewardPerBlock = ethers.utils.parseUnits("25", 6); // 25 USDC per block
        const fundingAmount = ethers.utils.parseUnits("2500", 6); // 2500 USDC total
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Deposit tokens to trader, then approve and fund the program
        await rewardToken6.contract.deposit(traderAddress, fundingAmount);
        await rewardToken6.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken6.address, rewardPerBlock, fundingAmount
        , false);

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken6.address, false);

        // Wait for 10 blocks to accumulate rewards
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        const pendingRewards = await incentives.getPendingRewards(baseQuotePoolId, traderAddress, rewardToken6.address, false);
        expect(pendingRewards).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("50", 6));

        const initialBalance = await rewardToken6.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken6.address, false);

        const finalBalance = await rewardToken6.balanceOf(traderAddress);
        
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("50", 6));
        
        // Verify the actual amount is approximately 250 USDC (250 * 10^6)
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(BigNumber.from("250000000"), ethers.utils.parseUnits("50", 6));
    });

    it("ambient: 8-decimal token (WBTC) rewards work correctly", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMintAmbient(liq); 

        const rewardPerBlock = ethers.utils.parseUnits("0.15", 8); // 0.15 WBTC per block
        const fundingAmount = ethers.utils.parseUnits("15", 8); // 15 WBTC total
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Deposit tokens to trader, then approve and fund the program
        await rewardToken8.contract.deposit(traderAddress, fundingAmount);
        await rewardToken8.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken8.address, rewardPerBlock, fundingAmount
        , false);

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken8.address, false);

        // Wait for 10 blocks to accumulate rewards
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        const pendingRewards = await incentives.getPendingRewards(baseQuotePoolId, traderAddress, rewardToken8.address, false);
        expect(pendingRewards).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("0.3", 8));

        const initialBalance = await rewardToken8.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken8.address, false);

        const finalBalance = await rewardToken8.balanceOf(traderAddress);
        
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("0.3", 8));
        
        // Verify the actual amount is approximately 1.5 WBTC (150000000 satoshis)
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(BigNumber.from("150000000"), ethers.utils.parseUnits("0.3", 8));
    });

    it("concentrated: 30 blocks with 6-decimal rewards accumulate correctly", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("5", 6); // 5 USDC per block
        const fundingAmount = ethers.utils.parseUnits("500", 6);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        await rewardToken6.contract.deposit(traderAddress, fundingAmount);
        await rewardToken6.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken6.address, rewardPerBlock, fundingAmount
        , true);

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken6.address, true);

        // Wait for 30 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(30).toString(16)}`]);

        const pendingRewards = await incentives.getPendingRewards(baseQuotePoolId, traderAddress, rewardToken6.address, true);
        
        // Should accumulate 30 blocks worth of rewards - allow tolerance for transaction timing
        expect(pendingRewards).to.be.closeTo(rewardPerBlock.mul(30), ethers.utils.parseUnits("10", 6));

        const initialBalance = await rewardToken6.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken6.address, true);

        const finalBalance = await rewardToken6.balanceOf(traderAddress);
        
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(30), ethers.utils.parseUnits("10", 6));
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(ethers.utils.parseUnits("150", 6), ethers.utils.parseUnits("10", 6));
    });

    it("concentrated: 30 blocks with 8-decimal rewards accumulate correctly", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock = ethers.utils.parseUnits("0.025", 8); // 0.025 WBTC per block
        const fundingAmount = ethers.utils.parseUnits("2.5", 8);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        await rewardToken8.contract.deposit(traderAddress, fundingAmount);
        await rewardToken8.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken8.address, rewardPerBlock, fundingAmount
        , true);

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken8.address, true);

        // Wait for 30 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(30).toString(16)}`]);

        const pendingRewards = await incentives.getPendingRewards(baseQuotePoolId, traderAddress, rewardToken8.address, true);
        
        // Should accumulate 30 blocks worth of rewards - allow tolerance for transaction timing
        expect(pendingRewards).to.be.closeTo(rewardPerBlock.mul(30), ethers.utils.parseUnits("0.05", 8));

        const initialBalance = await rewardToken8.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken8.address, true);

        const finalBalance = await rewardToken8.balanceOf(traderAddress);
        
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(30), ethers.utils.parseUnits("0.05", 8));
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(ethers.utils.parseUnits("0.75", 8), ethers.utils.parseUnits("0.05", 8));
    });

    it("concentrated: precision is maintained with 6-decimal tokens in reward calculations", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        // Test with small reward amounts to verify precision
        const rewardPerBlock = ethers.utils.parseUnits("0.123456", 6); // 0.123456 USDC per block (uses all 6 decimals)
        const fundingAmount = ethers.utils.parseUnits("12.34567", 6);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        await rewardToken6.contract.deposit(traderAddress, fundingAmount);
        await rewardToken6.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken6.address, rewardPerBlock, fundingAmount
        , true);

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken6.address, true);

        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        const pendingRewards = await incentives.getPendingRewards(baseQuotePoolId, traderAddress, rewardToken6.address, true);
        
        // Should preserve all decimal precision for 10 blocks - allow tolerance for transaction timing
        expect(pendingRewards).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("0.2", 6));
        expect(pendingRewards).to.be.closeTo(BigNumber.from("1234560"), ethers.utils.parseUnits("0.2", 6));

        const initialBalance = await rewardToken6.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken6.address, true);

        const finalBalance = await rewardToken6.balanceOf(traderAddress);
        
        // Verify precision is maintained
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("0.2", 6));
    });

    it("concentrated: precision is maintained with 8-decimal tokens in reward calculations", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        // Test with small reward amounts to verify precision
        const rewardPerBlock = ethers.utils.parseUnits("0.01234567", 8); // Uses all 8 decimals per block
        const fundingAmount = ethers.utils.parseUnits("1.2345678", 8);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        await rewardToken8.contract.deposit(traderAddress, fundingAmount);
        await rewardToken8.approve(await test1.trader, await incentives.address, fundingAmount);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken8.address, rewardPerBlock, fundingAmount
        , true);

        await incentives.register(traderAddress, baseQuotePoolId, rewardToken8.address, true);

        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        const pendingRewards = await incentives.getPendingRewards(baseQuotePoolId, traderAddress, rewardToken8.address, true);
        
        // Should preserve all decimal precision for 10 blocks - allow tolerance for transaction timing
        expect(pendingRewards).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("0.02", 8));
        expect(pendingRewards).to.be.closeTo(BigNumber.from("12345670"), ethers.utils.parseUnits("0.02", 8));

        const initialBalance = await rewardToken8.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken8.address, true);

        const finalBalance = await rewardToken8.balanceOf(traderAddress);
        
        // Verify precision is maintained
        expect(finalBalance.sub(initialBalance)).to.be.closeTo(rewardPerBlock.mul(10), ethers.utils.parseUnits("0.02", 8));
    });

    it("concentrated: mixed decimal tokens can run simultaneously", async () => {
        const liq = BigNumber.from(1000000);
        await test1.testMint(-5000, 8000, liq); 

        const rewardPerBlock6 = ethers.utils.parseUnits("10", 6);
        const rewardPerBlock8 = ethers.utils.parseUnits("0.05", 8);
        const rewardPerBlock18 = ethers.utils.parseUnits("5", 18);
        
        const fundingAmount6 = ethers.utils.parseUnits("1000", 6);
        const fundingAmount8 = ethers.utils.parseUnits("5", 8);
        const fundingAmount18 = ethers.utils.parseUnits("500", 18);
        
        const traderAddress = await (await test1.trader).getAddress();
        
        // Fund all three programs
        await rewardToken6.contract.deposit(traderAddress, fundingAmount6);
        await rewardToken6.approve(await test1.trader, await incentives.address, fundingAmount6);
        
        await rewardToken8.contract.deposit(traderAddress, fundingAmount8);
        await rewardToken8.approve(await test1.trader, await incentives.address, fundingAmount8);
        
        await rewardToken18.contract.deposit(traderAddress, fundingAmount18);
        await rewardToken18.approve(await test1.trader, await incentives.address, fundingAmount18);
        
        // Create all three programs
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken6.address, rewardPerBlock6, fundingAmount6
        , true);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken8.address, rewardPerBlock8, fundingAmount8
        , true);
        
        await incentives.createOrModifyProgram(baseQuotePoolId, rewardToken18.address, rewardPerBlock18, fundingAmount18
        , true);

        // Register for all three
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken6.address, true);
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken8.address, true);
        await incentives.register(traderAddress, baseQuotePoolId, rewardToken18.address, true);

        // Wait for 10 blocks
        await hardhat.network.provider.send("hardhat_mine", [`0x${(10).toString(16)}`]);

        // Claim all three
        const initialBalance6 = await rewardToken6.balanceOf(traderAddress);
        const initialBalance8 = await rewardToken8.balanceOf(traderAddress);
        const initialBalance18 = await rewardToken18.balanceOf(traderAddress);

        await incentives.claimRewards(baseQuotePoolId, rewardToken6.address, true);
        await incentives.claimRewards(baseQuotePoolId, rewardToken8.address, true);
        await incentives.claimRewards(baseQuotePoolId, rewardToken18.address, true);

        const finalBalance6 = await rewardToken6.balanceOf(traderAddress);
        const finalBalance8 = await rewardToken8.balanceOf(traderAddress);
        const finalBalance18 = await rewardToken18.balanceOf(traderAddress);
        
        // Verify each reward is correct for 10 blocks - allow tolerance for transaction timing
        expect(finalBalance6.sub(initialBalance6)).to.be.closeTo(rewardPerBlock6.mul(10), ethers.utils.parseUnits("50", 6));
        expect(finalBalance8.sub(initialBalance8)).to.be.closeTo(rewardPerBlock8.mul(10), ethers.utils.parseUnits("0.2", 8));
        expect(finalBalance18.sub(initialBalance18)).to.be.closeTo(rewardPerBlock18.mul(10), ethers.utils.parseUnits("20", 18));
    });
});
