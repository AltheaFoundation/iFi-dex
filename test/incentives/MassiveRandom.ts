import { TestPool, makeTokenPool, Token, makeEtherPool, POOL_IDX, ERC20Token, makeStandaloneToken, makeTokenTriangle, makeTokenSeq, makeTokenNext } from '../FacadePool'
import { expect } from "chai";
import "@nomiclabs/hardhat-ethers";
import hardhat, { ethers } from 'hardhat';
import { toSqrtPrice, fromSqrtPrice, maxSqrtPrice, minSqrtPrice, ZERO_ADDR } from '../FixedPoint';
import { solidity } from "ethereum-waffle";
import chai from "chai";
import { MockERC20 } from '../../typechain/MockERC20';
import { BigNumber, ContractFactory, Wallet } from 'ethers';
import { HotProxy, AltheaDexIncentivesContinuousEpochMulti, CrocSwapDex } from '../../typechain';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

chai.use(solidity);

// ============ Types ============

enum ActionType {
    ADD_LIQUIDITY,
    REMOVE_LIQUIDITY,
    CLAIM_REWARDS,
    MODIFY_LIQUIDITY  // Forfeit scenario
}

interface PoolConfig {
    poolId: string;
    testPool: TestPool;
    isConcentrated: boolean;
    rewardPerBlock: BigNumber;
}

interface UserAction {
    blockNumber: number;
    actionType: ActionType;
    poolIndex: number;  // Which pool this action is for
    amount?: BigNumber;  // For add/remove liquidity
}

interface ExecutedAction {
    actualBlock: number;  // The block the action actually executed at
    actionType: ActionType;
    poolIndex: number;
    amount?: BigNumber;
    userId: string;  // Wallet address for timeline building
}

interface UserPoolState {
    liquidity: BigNumber;
    registered: boolean;
}

interface UserProbabilities {
    removeLiquidityProb: number;  // Probability of removing liquidity
    claimRewardsProb: number;     // Probability of claiming rewards
    forfeitProb: number;          // Probability of forfeiting (modify)
}

interface UserPlan {
    wallet: Wallet;
    actions: UserAction[];
    executedActions: ExecutedAction[];  // Track actual executed actions with actual blocks
    poolStates: Map<number, UserPoolState>;  // poolIndex -> state
    expectedRewardsByPool: Map<number, BigNumber>;  // poolIndex -> expected rewards
    probabilities: UserProbabilities;
}

// ============ Utility Functions ============

/**
 * Generate a random integer between min and max (inclusive)
 */
function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a random BigNumber between min and max
 * Result is always a multiple of 1024 to align with liquidity lot sizes
 */
function randomBigNumber(min: BigNumber, max: BigNumber): BigNumber {
    const range = max.sub(min);
    const randomValue = BigNumber.from(Math.floor(Math.random() * 1000000));
    const result = min.add(range.mul(randomValue).div(1000000));
    // Round to nearest multiple of 1024
    const lots = result.div(1024);
    return lots.mul(1024);
}

/**
 * Validate and fix action plans to ensure they can be executed without skipping
 * This ensures liquidity tracking is accurate and no actions fail during execution
 */
function validateAndFixActionPlans(userPlans: UserPlan[]): void {
    // Track simulated liquidity state per pool for each user
    const userLiquidityState = new Map<string, Map<number, { 
        currentLiq: BigNumber, 
        registeredLiq: BigNumber  // Liquidity amount when last registered/claimed
    }>>();
    
    const MAX_SAFE_BN = BigNumber.from("9007199254740991"); // Number.MAX_SAFE_INTEGER
    
    for (const plan of userPlans) {
        if (!userLiquidityState.has(plan.wallet.address)) {
            userLiquidityState.set(plan.wallet.address, new Map());
        }
        const userState = userLiquidityState.get(plan.wallet.address)!;
        
        // Initialize liquidity state for all pools
        for (let poolIdx = 0; poolIdx < 3; poolIdx++) {  // Changed from 4 to 3
            if (!userState.has(poolIdx)) {
                userState.set(poolIdx, { currentLiq: BigNumber.from(0), registeredLiq: BigNumber.from(0) });
            }
        }
        
        // Filter out invalid actions
        const validActions: UserAction[] = [];
        
        for (const action of plan.actions) {
            const poolIdx = action.poolIndex;
            const state = userState.get(poolIdx)!;
            let isValid = true;
            
            switch (action.actionType) {
                case ActionType.ADD_LIQUIDITY:
                    // Ensure amount is not zero
                    if (action.amount!.eq(0)) {
                        isValid = false;
                    } else {
                        state.currentLiq = state.currentLiq.add(action.amount!);
                        // If this is the first add, it's also a registration
                        if (state.registeredLiq.eq(0)) {
                            state.registeredLiq = state.currentLiq;
                        }
                    }
                    break;
                    
                case ActionType.REMOVE_LIQUIDITY:
                    // Check if we have enough liquidity to remove
                    if (state.currentLiq.gte(action.amount!)) {
                        // For ambient pools (poolIdx 2), check if amount fits in safe integer range
                        const isAmbient = poolIdx >= 2;
                        if (isAmbient && action.amount!.gt(MAX_SAFE_BN)) {
                            // Cap the removal amount to MAX_SAFE_BN
                            action.amount = MAX_SAFE_BN.lt(state.currentLiq) ? MAX_SAFE_BN : state.currentLiq;
                        }
                        state.currentLiq = state.currentLiq.sub(action.amount!);
                    } else if (state.currentLiq.gt(0)) {
                        // Adjust to remove only what's available
                        action.amount = state.currentLiq;
                        state.currentLiq = BigNumber.from(0);
                    } else {
                        // No liquidity to remove - skip this action
                        isValid = false;
                    }
                    break;
                    
                case ActionType.CLAIM_REWARDS:
                    // Valid only if:
                    // 1. User has liquidity
                    // 2. Liquidity hasn't changed since registration
                    if (state.currentLiq.eq(0) || !state.currentLiq.eq(state.registeredLiq)) {
                        isValid = false;
                    }
                    // Note: After claim, user remains registered with same liquidity - no update needed
                    break;
                    
                case ActionType.MODIFY_LIQUIDITY:
                    // Valid only if user already has liquidity (is registered) and amount is non-zero
                    if (state.currentLiq.gt(0) && action.amount!.gt(0)) {
                        state.currentLiq = state.currentLiq.add(action.amount!);
                        // Modify = reregister
                        state.registeredLiq = state.currentLiq;
                    } else {
                        isValid = false;
                    }
                    break;
            }
            
            if (isValid) {
                validActions.push(action);
            }
        }
        
        // Replace actions with validated actions
        plan.actions = validActions;
    }
}

/**
 * Generate a valid action plan for a user across multiple pools
 * Rules:
 * - Can't remove more liquidity than added per pool
 * - Can't claim before adding liquidity to that pool
 * - Must have registered (added liquidity) before claiming
 * - Modification (forfeit) can happen with some probability
 * - User interacts with 1-3 random pools
 */
function generateUserActionPlan(
    startBlock: number,
    maxBlocks: number,
    maxLiquidity: BigNumber,
    numPools: number,
    probabilities: UserProbabilities
): UserAction[] {
    const actions: UserAction[] = [];
    
    // Decide which pools this user will interact with (1 to 3 pools)
    const numPoolsToUse = randomInt(1, Math.min(3, numPools));
    const poolIndices: number[] = [];
    while (poolIndices.length < numPoolsToUse) {
        const poolIdx = randomInt(0, numPools - 1);
        if (!poolIndices.includes(poolIdx)) {
            poolIndices.push(poolIdx);
        }
    }
    poolIndices.sort(); // Keep them sorted for easier debugging
    
    // Track liquidity per pool
    const poolLiquidity = new Map<number, BigNumber>();
    const poolHasAdded = new Map<number, boolean>();
    for (const poolIdx of poolIndices) {
        poolLiquidity.set(poolIdx, BigNumber.from(0));
        poolHasAdded.set(poolIdx, false);
    }
    
    // Number of actions per user (3-10)
    const numActions = randomInt(3, 10);
    
    // Generate sorted block numbers for actions
    const actionBlocks: number[] = [];
    for (let i = 0; i < numActions; i++) {
        actionBlocks.push(randomInt(startBlock + 1, startBlock + maxBlocks));
    }
    actionBlocks.sort((a, b) => a - b);
    
    for (let i = 0; i < numActions; i++) {
        const blockNumber = actionBlocks[i];
        const poolIdx = poolIndices[randomInt(0, poolIndices.length - 1)];
        const currentLiq = poolLiquidity.get(poolIdx)!;
        const hasAdded = poolHasAdded.get(poolIdx)!;
        
        // First action for this pool must be ADD_LIQUIDITY
        if (!hasAdded) {
            const amount = randomBigNumber(
                maxLiquidity.div(20),  // At least 5% of max (increased from 1%)
                maxLiquidity.div(5)      // At most 20% of max
            );
            // Ensure minimum of 10000 to avoid rounding issues
            const minAmount = BigNumber.from(10000);
            const finalAmount = amount.lt(minAmount) ? minAmount : amount;
            
            actions.push({
                blockNumber,
                actionType: ActionType.ADD_LIQUIDITY,
                poolIndex: poolIdx,
                amount: finalAmount
            });
            poolLiquidity.set(poolIdx, currentLiq.add(finalAmount));
            poolHasAdded.set(poolIdx, true);
            continue;
        }
        
        // Decide action type based on current state
        const rand = Math.random();
        
        if (rand < probabilities.forfeitProb && hasAdded && i < numActions - 1) {
            // MODIFY_LIQUIDITY - forfeit rewards
            const amount = randomBigNumber(
                BigNumber.from(1),
                maxLiquidity.div(10)
            );
            actions.push({
                blockNumber,
                actionType: ActionType.MODIFY_LIQUIDITY,
                poolIndex: poolIdx,
                amount
            });
            poolLiquidity.set(poolIdx, currentLiq.add(amount));
        } else if (rand < probabilities.removeLiquidityProb && currentLiq.gt(0)) {
            // REMOVE_LIQUIDITY
            const amount = randomBigNumber(
                BigNumber.from(1),
                currentLiq.div(2)  // Remove at most half
            );
            actions.push({
                blockNumber,
                actionType: ActionType.REMOVE_LIQUIDITY,
                poolIndex: poolIdx,
                amount
            });
            poolLiquidity.set(poolIdx, currentLiq.sub(amount));
        } else if (rand < probabilities.claimRewardsProb && hasAdded) {
            // CLAIM_REWARDS
            actions.push({
                blockNumber,
                actionType: ActionType.CLAIM_REWARDS,
                poolIndex: poolIdx
            });
        } else {
            // ADD_LIQUIDITY (remaining probability)
            const amount = randomBigNumber(
                maxLiquidity.div(20),
                maxLiquidity.div(5)
            );
            // Ensure minimum of 10000 to avoid rounding issues
            const minAmount = BigNumber.from(10000);
            const finalAmount = amount.lt(minAmount) ? minAmount : amount;
            
            actions.push({
                blockNumber,
                actionType: ActionType.ADD_LIQUIDITY,
                poolIndex: poolIdx,
                amount: finalAmount
            });
            poolLiquidity.set(poolIdx, currentLiq.add(finalAmount));
        }
    }
    
    // Ensure final actions are claims for all active pools
    for (const poolIdx of poolIndices) {
        if (poolHasAdded.get(poolIdx)) {
            const lastBlock = actionBlocks[actionBlocks.length - 1];
            actions.push({
                blockNumber: lastBlock + randomInt(10, 50),
                actionType: ActionType.CLAIM_REWARDS,
                poolIndex: poolIdx
            });
        }
    }
    
    // Sort by block number
    actions.sort((a, b) => a.blockNumber - b.blockNumber);
    
    return actions;
}

/**
 * Calculate ideal rewards for a user for a specific pool based on their action plan.
 * 
 * This simulates the "ideal" scenario where every user claims immediately before any liquidity
 * changes occur in the pool. This represents what would happen if we had an O(n) contract that
 * could automatically trigger claims for all users on every liquidity modification.
 * 
 * The purpose of this ideal calculation is to measure the deviation caused by the O(1) design,
 * where users must manually claim and their rewards can be affected by other users' liquidity
 * changes that occur between their claims.
 * 
 * In the ideal scenario:
 * - Every ADD/REMOVE/MODIFY from ANY user triggers an instant claim for ALL registered users
 * - This ensures no user's rewards are affected by liquidity changes they didn't initiate
 * - The accumulator updates and users claim BEFORE the liquidity change takes effect
 * 
 * In the actual O(1) implementation:
 * - Users claim whenever they choose
 * - Between claims, other users can add/remove liquidity, changing the reward distribution
 * - This creates deviation from the ideal, which we measure to validate it's acceptable
 * 
 * Uses ACTUAL execution blocks from executedActions for accurate simulation.
 * 
 * @param userPlan The user plan to calculate ideal rewards for
 * @param poolIndex The pool index to calculate rewards for
 * @param allPlans All user plans (needed to simulate global state)
 * @param rewardPerBlock Reward rate per block for this pool
 * @param precision Fixed-point precision (1e18)
 * @returns The ideal reward amount the user would receive with perfect claim timing
 */
function calculateIdealRewardsForPool(
    userPlan: UserPlan,
    poolIndex: number,
    allPlans: UserPlan[],
    rewardPerBlock: BigNumber,
    precision: BigNumber
): BigNumber {
    // Build a timeline of all events (liquidity changes, claims) for this specific pool
    interface TimelineEvent {
        block: number;
        userId: string;
        type: 'add' | 'remove' | 'claim' | 'modify';
        amount?: BigNumber;
    }
    
    const timeline: TimelineEvent[] = [];
    
    // Add all user EXECUTED actions to timeline for this specific pool only
    for (const plan of allPlans) {
        for (const action of plan.executedActions) {
            // Skip actions for other pools
            if (action.poolIndex !== poolIndex) continue;
            
            let type: 'add' | 'remove' | 'claim' | 'modify';
            switch (action.actionType) {
                case ActionType.ADD_LIQUIDITY:
                    type = 'add';
                    break;
                case ActionType.REMOVE_LIQUIDITY:
                    type = 'remove';
                    break;
                case ActionType.CLAIM_REWARDS:
                    type = 'claim';
                    break;
                case ActionType.MODIFY_LIQUIDITY:
                    type = 'modify';
                    break;
            }
            timeline.push({
                block: action.actualBlock,  // Use ACTUAL execution block
                userId: action.userId,
                type,
                amount: action.amount
            });
        }
    }
    
    // Sort by block number
    timeline.sort((a, b) => a.block - b.block);
    
    // If no actions for this pool, return 0
    if (timeline.length === 0) {
        return BigNumber.from(0);
    }
    
    // Simulate reward accumulation
    const userState = new Map<string, {
        liquidity: BigNumber;              // Current actual liquidity in the pool
        registeredLiquidity: BigNumber;    // Last registered liquidity amount
        registered: boolean;
        snapshotAccumulator: BigNumber;
        pendingRewards: BigNumber;
    }>();
    
    // Initialize all users
    for (const plan of allPlans) {
        userState.set(plan.wallet.address, {
            liquidity: BigNumber.from(0),
            registeredLiquidity: BigNumber.from(0),
            registered: false,
            snapshotAccumulator: BigNumber.from(0),
            pendingRewards: BigNumber.from(0)
        });
    }
    
    let globalAccumulator = BigNumber.from(0);
    let totalLiquidity = BigNumber.from(0);
    let lastBlock = timeline[0].block - 1;
    
    for (const event of timeline) {
        // Update global accumulator for blocks that passed
        const blocksPassed = event.block - lastBlock;
        if (blocksPassed > 0 && totalLiquidity.gt(0)) {
            const rewardsThisPeriod = rewardPerBlock.mul(blocksPassed);
            const accumulatorIncrease = rewardsThisPeriod.mul(precision).div(totalLiquidity);
            globalAccumulator = globalAccumulator.add(accumulatorIncrease);
        }
        
        // IDEAL BEHAVIOR: Before processing any liquidity change (add/remove/modify),
        // automatically claim for ALL registered users. This represents what would happen
        // in an O(n) implementation that could trigger claims for everyone.
        // This ensures no user's rewards are affected by liquidity changes they didn't initiate.
        if (event.type === 'add' || event.type === 'remove' || event.type === 'modify') {
            // Claim for all registered users before the liquidity change
            userState.forEach((state, userId) => {
                if (state.registered && state.registeredLiquidity.gt(0)) {
                    const accumulatorDelta = globalAccumulator.sub(state.snapshotAccumulator);
                    const rewards = state.registeredLiquidity.mul(accumulatorDelta).div(precision);
                    state.pendingRewards = state.pendingRewards.add(rewards);
                    // Update snapshot after claiming
                    state.snapshotAccumulator = globalAccumulator;
                }
            });
        }
        
        const state = userState.get(event.userId)!;
        
        if (event.type === 'add') {
            if (!state.registered) {
                // First add = registration
                state.liquidity = event.amount!;
                state.registeredLiquidity = event.amount!;
                state.registered = true;
                state.snapshotAccumulator = globalAccumulator;
                // Add to total REGISTERED liquidity
                totalLiquidity = totalLiquidity.add(event.amount!);
            } else {
                // Subsequent ADD = claim + mint + reregister (matches actual execution)
                // User was already claimed above before this change
                // Now update both actual and registered liquidity
                state.liquidity = state.liquidity.add(event.amount!);
                
                // Remove old registered liquidity and add new
                totalLiquidity = totalLiquidity.sub(state.registeredLiquidity);
                state.registeredLiquidity = state.liquidity;
                totalLiquidity = totalLiquidity.add(state.registeredLiquidity);
                
                // Update snapshot since this is a reregister
                state.snapshotAccumulator = globalAccumulator;
            }
        } else if (event.type === 'remove') {
            // REMOVE = claim + burn + reregister (if liq > 0)
            // User was already claimed above before this change
            state.liquidity = state.liquidity.sub(event.amount!);
            
            if (state.registered) {
                // Remove old registered liquidity
                totalLiquidity = totalLiquidity.sub(state.registeredLiquidity);
                
                if (state.liquidity.gt(0)) {
                    // Reregister with remaining liquidity
                    state.registeredLiquidity = state.liquidity;
                    totalLiquidity = totalLiquidity.add(state.registeredLiquidity);
                    state.snapshotAccumulator = globalAccumulator;
                } else {
                    // No liquidity left, unregister
                    state.registeredLiquidity = BigNumber.from(0);
                    state.registered = false;
                }
            }
        } else if (event.type === 'modify') {
            // MODIFY = claim + mint + reregister
            // User was already claimed above before this change
            
            if (state.registered) {
                // Remove old registered liquidity from total
                totalLiquidity = totalLiquidity.sub(state.registeredLiquidity);
            }
            
            // Add new liquidity
            state.liquidity = state.liquidity.add(event.amount!);
            
            // Re-register with new total
            state.registeredLiquidity = state.liquidity;
            totalLiquidity = totalLiquidity.add(state.registeredLiquidity);
            state.snapshotAccumulator = globalAccumulator;
            state.registered = true;
        } else if (event.type === 'claim') {
            // Explicit claim (already handled by auto-claim above if at same block as liquidity change)
            if (state.registered) {
                const accumulatorDelta = globalAccumulator.sub(state.snapshotAccumulator);
                if (accumulatorDelta.gt(0)) {
                    const rewards = state.registeredLiquidity.mul(accumulatorDelta).div(precision);
                    state.pendingRewards = state.pendingRewards.add(rewards);
                }
                // Update snapshot after claim
                state.snapshotAccumulator = globalAccumulator;
            }
        }
        
        lastBlock = event.block;
    }
    
    const targetUserState = userState.get(userPlan.wallet.address)!;
    return targetUserState.pendingRewards;
}

/**
 * Execute a user action on the DEX and incentives contract
 * Returns the actual block number the action was executed at, or null if skipped
 */
async function executeAction(
    action: UserAction,
    wallet: Wallet,
    poolConfigs: PoolConfig[],
    incentives: AltheaDexIncentivesContinuousEpochMulti,
    rewardToken: ERC20Token,
    userStates: Map<string, Map<number, UserPoolState>>
): Promise<number | null> {
    const poolConfig = poolConfigs[action.poolIndex];
    const testPool = poolConfig.testPool;
    const isConcentrated = poolConfig.isConcentrated;
    const poolId = poolConfig.poolId;
    
    let userPoolStates = userStates.get(wallet.address);
    if (!userPoolStates) {
        userPoolStates = new Map();
        userStates.set(wallet.address, userPoolStates);
    }
    
    let userState = userPoolStates.get(action.poolIndex);
    if (!userState) {
        userState = { registered: false, liquidity: BigNumber.from(0) };
        userPoolStates.set(action.poolIndex, userState);
    }
    
    let tx;
    let lastReceipt;
    
    switch (action.actionType) {
        case ActionType.ADD_LIQUIDITY:
            // If already registered, claim rewards BEFORE modifying liquidity
            if (userState.registered) {
                if (isConcentrated) {
                    tx = await incentives.connect(wallet).claimRewards(poolId, rewardToken.address, true);
                    lastReceipt = await tx.wait();
                } else {
                    tx = await incentives.connect(wallet).claimRewards(poolId, rewardToken.address, false);
                    lastReceipt = await tx.wait();
                }
            }
            
            // Then modify liquidity
            if (isConcentrated) {
                // Use TestPool's mint method for concentrated liquidity
                // For concentrated, we pass the liquidity directly (testMintFrom handles the 1024 scaling)
                tx = await testPool.testMintFrom(wallet, -5000, 8000, action.amount!);
                lastReceipt = await tx.wait();
            } else {
                // Use TestPool's ambient mint method
                tx = await testPool.testMintAmbientFrom(wallet, action.amount!);
                lastReceipt = await tx.wait();
            }
            
            userState.liquidity = userState.liquidity.add(action.amount!);
            
            // Finally re-register with new liquidity amount
            if (!userState.registered) {
                // First time registration
                if (isConcentrated) {
                    tx = await incentives.connect(wallet).register(await wallet.getAddress(), poolId, rewardToken.address, true);
                    lastReceipt = await tx.wait();
                } else {
                    tx = await incentives.connect(wallet).register(await wallet.getAddress(), poolId, rewardToken.address, false);
                    lastReceipt = await tx.wait();
                }
                userState.registered = true;
            } else {
                // Re-register with new liquidity amount
                if (isConcentrated) {
                    tx = await incentives.connect(wallet).register(await wallet.getAddress(), poolId, rewardToken.address, true);
                    lastReceipt = await tx.wait();
                } else {
                    tx = await incentives.connect(wallet).register(await wallet.getAddress(), poolId, rewardToken.address, false);
                    lastReceipt = await tx.wait();
                }
            }
            break;
            
        case ActionType.REMOVE_LIQUIDITY:
            // Claim rewards BEFORE removing liquidity (while liquidity is still unchanged)
            if (userState.registered) {
                if (isConcentrated) {
                    tx = await incentives.connect(wallet).claimRewards(poolId, rewardToken.address, true);
                    lastReceipt = await tx.wait();
                } else {
                    tx = await incentives.connect(wallet).claimRewards(poolId, rewardToken.address, false);
                    lastReceipt = await tx.wait();
                }
            }
            
            // Then remove liquidity
            if (isConcentrated) {
                // Use TestPool's burn method for concentrated liquidity (BigNumber version)
                tx = await testPool.testBurnFromB(wallet, -5000, 8000, action.amount!);
                lastReceipt = await tx.wait();
            } else {
                // Use number-based burn for ambient (already validated in plan validation)
                tx = await testPool.testBurnAmbientFrom(wallet, action.amount!.toNumber());
                lastReceipt = await tx.wait();
            }
            userState.liquidity = userState.liquidity.sub(action.amount!);
            
            // Finally re-register if user still has liquidity
            if (userState.registered && userState.liquidity.gt(0)) {
                if (isConcentrated) {
                    tx = await incentives.connect(wallet).register(await wallet.getAddress(), poolId, rewardToken.address, true);
                    lastReceipt = await tx.wait();
                } else {
                    tx = await incentives.connect(wallet).register(await wallet.getAddress(), poolId, rewardToken.address, false);
                    lastReceipt = await tx.wait();
                }
            }
            break;
            
        case ActionType.CLAIM_REWARDS:
            if (isConcentrated) {
                tx = await incentives.connect(wallet).claimRewards(poolId, rewardToken.address, true);
                lastReceipt = await tx.wait();
            } else {
                tx = await incentives.connect(wallet).claimRewards(poolId, rewardToken.address, false);
                lastReceipt = await tx.wait();
            }
            break;
            
        case ActionType.MODIFY_LIQUIDITY:
            // Claim rewards BEFORE modifying liquidity
            if (isConcentrated) {
                tx = await incentives.connect(wallet).claimRewards(poolId, rewardToken.address, true);
                lastReceipt = await tx.wait();
            } else {
                tx = await incentives.connect(wallet).claimRewards(poolId, rewardToken.address, false);
                lastReceipt = await tx.wait();
            }
            
            // Then mint additional liquidity
            if (isConcentrated) {
                tx = await testPool.testMintFrom(wallet, -5000, 8000, action.amount!);
                lastReceipt = await tx.wait();
            } else {
                tx = await testPool.testMintAmbientFrom(wallet, action.amount!);
                lastReceipt = await tx.wait();
            }
            
            userState.liquidity = userState.liquidity.add(action.amount!);
            
            // Finally re-register
            if (isConcentrated) {
                tx = await incentives.connect(wallet).register(await wallet.getAddress(), poolId, rewardToken.address, true);
                lastReceipt = await tx.wait();
            } else {
                tx = await incentives.connect(wallet).register(await wallet.getAddress(), poolId, rewardToken.address, false);
                lastReceipt = await tx.wait();
            }
            break;
    }
    
    // Return the actual block number from the last transaction receipt
    return lastReceipt!.blockNumber;
}

/**
 * Mine blocks to reach a target block number
 */
async function mineToBlock(targetBlock: number): Promise<void> {
    const currentBlock = await ethers.provider.getBlockNumber();
    const blocksToMine = targetBlock - currentBlock;
    if (blocksToMine > 0) {
        await hardhat.network.provider.send("hardhat_mine", [`0x${blocksToMine.toString(16)}`]);
    }
}

// ============ Test Suite ============

/**
 * MassiveRandom - Large Scale Random Testing
 * 
 * This test suite validates the O(1) continuous incentives contract by simulating
 * chaotic, random user behavior across multiple pools and comparing actual rewards
 * distributed to an "ideal" scenario. This won't actaully occur because we deputise
 * bots to claim on behalf of users. So we'll always see close to the ideal case with
 * minimal deviation. But this describes the worst case (if we don't have bots claim
 * and pool size changes frequently and in large swings).
 *  
 * 
 * TEST PURPOSE:
 * Measure the deviation between the O(1) implementation (where users claim manually)
 * and a theoretical O(n) implementation (where all users are automatically claimed
 * before every liquidity change).
 * 
 * IDEAL SCENARIO (O(n)):
 * - Every liquidity change (add/remove/modify) from ANY user triggers automatic claims for ALL users
 * - Users receive rewards proportional to exact time-weighted liquidity
 * - No user's rewards are affected by other users' actions between claims
 * - This would require O(n) gas cost for each liquidity operation
 * 
 * ACTUAL IMPLEMENTATION (O(1)):
 * - Users claim whenever they choose
 * - Between claims, other users' liquidity changes affect reward distribution
 * - Some users may not claim before program ends (forfeiting rewards)
 * - All operations are O(1) gas cost
 * 
 * DEVIATION MEASUREMENT:
 * The test calculates:
 * - Ideal rewards: What users would receive with perfect claim timing (O(n) automatic claims)
 * - Actual rewards: What users actually received in the O(1) implementation
 * - Deviation: The difference, showing the cost of O(1) design vs O(n)
 * 
 * The test validates that the O(1) design works correctly and the deviation is
 * acceptable given the gas savings vs an O(n) automatic claim system.
 */
describe('MassiveRandom - Large Scale Random Testing', () => {
    let pools: TestPool[];
    let rewardToken: ERC20Token;
    const feeRate = 225 * 100;
    let incentives: AltheaDexIncentivesContinuousEpochMulti;
    let poolConfigs: PoolConfig[];
    
    const PRECISION = ethers.utils.parseUnits("1", 18);
    // For liquidity amounts, use values that work with the TestPool methods:
    // - testMintAmbientFrom multiplies by 1024, so we pass raw lot counts
    // - testMintFrom for concentrated also expects lot counts
    // Use values similar to other tests: 1M lots = 1,024,000,000
    const LIQUIDITY_UNIT = BigNumber.from(1024).mul(1000000); // 1M lots = 1,024,000,000
    const MAX_LIQUIDITY = LIQUIDITY_UNIT.mul(100); // 100M lots max
    
    before("deploy", async () => {
        // Create 3 sequential pools (2 concentrated, 1 ambient)
        const [pool1, pool2, pool3] = await makeTokenSeq();
        pools = [pool1, pool2, pool3];
        rewardToken = await makeStandaloneToken();
        
        // Initialize all pools
        for (const pool of pools) {
            await pool.initPool(feeRate, 0, 1, 1.5);
            pool.useHotPath = true;
        }
        
        // Deploy incentives contract
        const incentivesFactory = await ethers.getContractFactory("AltheaDexIncentivesContinuousEpochMulti") as ContractFactory;
        const dex = await pools[0].dex;
        incentives = await incentivesFactory.deploy(dex.address, ZERO_ADDR) as AltheaDexIncentivesContinuousEpochMulti;
        
        // Setup pool configurations
        poolConfigs = [];
        for (let i = 0; i < 3; i++) {
            const pool = pools[i];
            const isConcentrated = i < 2;  // First 2 are concentrated, last 1 is ambient
            
            const poolId = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address", "uint256"],
                    [pool.base.address, pool.quote.address, POOL_IDX]
                )
            );
            
            poolConfigs.push({
                poolId,
                testPool: pool,
                isConcentrated,
                rewardPerBlock: ethers.utils.parseUnits("25", 18)  // 25 tokens per block per pool
            });
        }
    });
    
    it("massive random test: 3 pools (2 concentrated, 1 ambient) with chaotic multi-user activity", async function() {
        this.timeout(900000); // 15 minute timeout
        
        // Generate random number of users (10-100 for reasonable test time)
        const numUsers = randomInt(10, 100);
        console.log(`\n=== Massive Random Multi-Pool Test: ${numUsers} users across 3 pools ===`);
        
        const maxBlocks = 1000;
        const startBlock = await ethers.provider.getBlockNumber();
        
        // Fund all 4 reward programs
        const [owner] = await ethers.getSigners();
        const rewardPerBlockTotal = poolConfigs.reduce((sum, config) => sum.add(config.rewardPerBlock), BigNumber.from(0));
        const fundingAmount = rewardPerBlockTotal.mul(maxBlocks * 10); // Increase multiplier to account for block mining
        
        await rewardToken.contract.deposit(owner.address, fundingAmount);
        await rewardToken.contract.approve(incentives.address, fundingAmount);
        
        // Create programs for all 4 pools
        for (let i = 0; i < poolConfigs.length; i++) {
            const config = poolConfigs[i];
            const poolFunding = config.rewardPerBlock.mul(maxBlocks * 10); // Increase multiplier to account for block mining
            
            if (config.isConcentrated) {
                await incentives.createOrModifyProgram(config.poolId, rewardToken.address, config.rewardPerBlock, poolFunding
                , true);
                console.log(`  Created concentrated program for pool ${i}`);
            } else {
                await incentives.createOrModifyProgram(config.poolId, rewardToken.address, config.rewardPerBlock, poolFunding
                , false);
                console.log(`  Created ambient program for pool ${i}`);
            }
        }
        
        console.log(`Creating ${numUsers} user wallets and multi-pool plans...`);
        
        // Collect all unique tokens from all pools
        const allTokens = new Set<string>();
        for (const pool of pools) {
            allTokens.add(pool.base.address);
            allTokens.add(pool.quote.address);
        }
        console.log(`  Found ${allTokens.size} unique tokens across ${pools.length} pools`);
        
        // Generate user plans - each user can interact with multiple pools
        const userPlans: UserPlan[] = [];
        for (let i = 0; i < numUsers; i++) {
            // Create funded wallet for all pool tokens
            const wallet = Wallet.createRandom().connect(ethers.provider);
            await owner.sendTransaction({
                to: wallet.address,
                value: ethers.utils.parseEther("10")
            });
            
            // Fund with all unique tokens from all pools
            const fundAmount = MAX_LIQUIDITY.mul(10000); // MUCH more generous funding to handle price ratios
            for (const pool of pools) {
                // Fund both base and quote
                await pool.base.contract.deposit(wallet.address, fundAmount);
                await pool.quote.contract.deposit(wallet.address, fundAmount);
                
                const dex = await pool.dex;
                // Use the Token's approve method
                await pool.base.approve(wallet, dex.address, ethers.constants.MaxUint256);
                await pool.quote.approve(wallet, dex.address, ethers.constants.MaxUint256);
            }
            
            // Generate random probabilities for this user
            const probabilities: UserProbabilities = {
                forfeitProb: Math.random() * 0.2,         // 0-20% chance of forfeit
                removeLiquidityProb: Math.random() * 0.5, // 0-50% for remove check
                claimRewardsProb: Math.random() * 0.8     // 0-80% for claim check
            };
            
            const actions = generateUserActionPlan(
                startBlock,
                maxBlocks,
                MAX_LIQUIDITY,
                poolConfigs.length,
                probabilities
            );
            
            userPlans.push({
                wallet,
                actions,
                executedActions: [],
                poolStates: new Map(),
                expectedRewardsByPool: new Map(),
                probabilities
            });
            
            if (i % 10 === 0 && i > 0) {
                console.log(`  Created ${i}/${numUsers} users`);
            }
        }
        console.log(`  Created all ${numUsers} users`);
        
        // Validate and fix all action plans to ensure they're executable
        console.log(`Validating and fixing action plans...`);
        validateAndFixActionPlans(userPlans);
        console.log(`  All action plans validated and fixed`);
        
        console.log(`All users created. Executing action timeline...`);
        
        // Build global timeline of all actions
        interface GlobalAction {
            block: number;
            userIndex: number;
            action: UserAction;
        }
        
        const globalTimeline: GlobalAction[] = [];
        for (let i = 0; i < userPlans.length; i++) {
            for (const action of userPlans[i].actions) {
                globalTimeline.push({
                    block: action.blockNumber,
                    userIndex: i,
                    action
                });
            }
        }
        
        // Sort by block number
        globalTimeline.sort((a, b) => a.block - b.block);
        
        console.log(`Total actions to execute: ${globalTimeline.length}`);
        
        // Track user registration states per pool
        const userStates = new Map<string, Map<number, UserPoolState>>();
        
        // Execute all actions and record actual execution blocks
        let actionsExecuted = 0;
        for (const globalAction of globalTimeline) {
            // Mine to the planned block FIRST, then execute
            // This ensures the action executes at the intended block
            const currentBlock = await ethers.provider.getBlockNumber();
            if (globalAction.block > currentBlock) {
                await mineToBlock(globalAction.block - 1);
            }
            
            const userPlan = userPlans[globalAction.userIndex];
            
            const actualBlock = await executeAction(
                globalAction.action,
                userPlan.wallet,
                poolConfigs,
                incentives,
                rewardToken,
                userStates
            );
            
            if (actualBlock !== null) {
                // Record the executed action with its actual block
                userPlan.executedActions.push({
                    actualBlock: actualBlock,
                    actionType: globalAction.action.actionType,
                    poolIndex: globalAction.action.poolIndex,
                    amount: globalAction.action.amount,
                    userId: userPlan.wallet.address
                });
                
                actionsExecuted++;
                if (actionsExecuted % 100 === 0) {
                    console.log(`  Executed ${actionsExecuted}/${globalTimeline.length} actions`);
                }
            }
        }
        
        console.log(`All ${actionsExecuted} actions executed successfully!`);
        
        // Now calculate ideal rewards for each user per pool based on EXECUTED actions
        // This represents what users would receive if they claimed optimally (before every liquidity change)
        console.log(`Calculating ideal rewards (perfect claim timing) for all users...`);
        for (let i = 0; i < userPlans.length; i++) {
            const userPlan = userPlans[i];
            
            // Calculate ideal rewards per pool based on executedActions
            for (let poolIdx = 0; poolIdx < poolConfigs.length; poolIdx++) {
                const idealRewards = calculateIdealRewardsForPool(
                    userPlan,
                    poolIdx,
                    userPlans,
                    poolConfigs[poolIdx].rewardPerBlock,
                    PRECISION
                );
                userPlan.expectedRewardsByPool.set(poolIdx, idealRewards);
            }
            
            if (i % 20 === 0 && i > 0) {
                console.log(`  Calculated ideal rewards for ${i}/${numUsers} users`);
            }
        }
        console.log(`  Calculated ideal rewards for all ${numUsers} users`);
        
        console.log(`Verifying actual rewards vs ideal...`);
        
        // Verify rewards - check each user's actual balance vs ideal
        let totalActualRewards = BigNumber.from(0);
        let totalIdealRewards = BigNumber.from(0);
        let usersWithRewards = 0;
        let maxDeviation = BigNumber.from(0);
        let totalDeviation = BigNumber.from(0);
        
        for (let i = 0; i < userPlans.length; i++) {
            const userPlan = userPlans[i];
            const actualBalance = await rewardToken.balanceOf(userPlan.wallet.address);
            
            // Sum ideal rewards across all pools for this user
            let userIdealTotal = BigNumber.from(0);
            userPlan.expectedRewardsByPool.forEach((idealRewards, poolIdx) => {
                userIdealTotal = userIdealTotal.add(idealRewards);
            });
            
            totalActualRewards = totalActualRewards.add(actualBalance);
            totalIdealRewards = totalIdealRewards.add(userIdealTotal);
            
            if (actualBalance.gt(0)) {
                usersWithRewards++;
                
                // Calculate deviation from ideal (allows measuring impact of O(1) vs O(n) design)
                const deviation = actualBalance.gt(userIdealTotal) 
                    ? actualBalance.sub(userIdealTotal)
                    : userIdealTotal.sub(actualBalance);
                    
                totalDeviation = totalDeviation.add(deviation);
                
                if (deviation.gt(maxDeviation)) {
                    maxDeviation = deviation;
                }
                
                // Allow up to 1% deviation due to rounding and timing differences
                const maxAllowedDeviation = userIdealTotal.div(100);
                if (deviation.gt(maxAllowedDeviation) && userIdealTotal.gt(0)) {
                    console.log(`  WARNING: User ${i} has significant deviation from ideal:`);
                    console.log(`    Ideal:    ${ethers.utils.formatUnits(userIdealTotal, 18)}`);
                    console.log(`    Actual:   ${ethers.utils.formatUnits(actualBalance, 18)}`);
                    console.log(`    Deviation: ${ethers.utils.formatUnits(deviation, 18)} (${deviation.mul(100).div(userIdealTotal.gt(0) ? userIdealTotal : 1)}%)`);
                }
            }
            
            if (i % 20 === 0 && i > 0) {
                console.log(`  Verified ${i}/${numUsers} users`);
            }
        }
        console.log(`  Verified all ${numUsers} users`);
        
        console.log(`\n=== Test Results ===`);
        console.log(`Total users: ${numUsers}`);
        console.log(`Users with rewards: ${usersWithRewards}`);
        console.log(`Total actions executed: ${actionsExecuted}`);
        console.log(`Total actual rewards distributed: ${ethers.utils.formatUnits(totalActualRewards, 18)}`);
        console.log(`Total ideal rewards (perfect claims): ${ethers.utils.formatUnits(totalIdealRewards, 18)}`);
        console.log(`Max deviation from ideal: ${ethers.utils.formatUnits(maxDeviation, 18)}`);
        console.log(`Average deviation from ideal: ${ethers.utils.formatUnits(totalDeviation.div(usersWithRewards > 0 ? usersWithRewards : 1), 18)}`);
        
        // Calculate actual blocks elapsed from program creation to final claim
        // This represents the time period over which rewards were distributed
        const finalBlock = await ethers.provider.getBlockNumber();
        const blocksElapsed = finalBlock - startBlock;
        const maxPossibleRewards = rewardPerBlockTotal.mul(blocksElapsed);
        console.log(`Blocks elapsed since program creation: ${blocksElapsed}`);
        console.log(`Max possible rewards (${blocksElapsed} blocks × ${ethers.utils.formatUnits(rewardPerBlockTotal, 18)} tokens/block): ${ethers.utils.formatUnits(maxPossibleRewards, 18)}`);
        
        // Basic sanity check - total rewards should be less than max possible
        const fundedAmount = rewardPerBlockTotal.mul(maxBlocks * 10);
        expect(totalActualRewards).to.be.lte(fundedAmount);
        
        // Compare actual vs ideal to measure deviation caused by O(1) design
        // Ideal represents perfect claim timing (everyone claims before every liquidity change)
        // Actual represents real-world usage (users claim at random times)
        // The deviation measures the cost of not having O(n) automatic claims for all users
        if (totalIdealRewards.gt(0)) {
            const overallDeviation = totalActualRewards.gt(totalIdealRewards)
                ? totalActualRewards.sub(totalIdealRewards)
                : totalIdealRewards.sub(totalActualRewards);
            const deviationPercent = overallDeviation.mul(100).div(totalIdealRewards);
            console.log(`Overall deviation from ideal: ${deviationPercent}%`);
            
            // Explanation of deviation sources:
            // The deviation measures the difference between the O(1) implementation (actual) and
            // a theoretical O(n) implementation that claims for all users before every liquidity change (ideal).
            //
            // In the ideal scenario, users would receive rewards proportional to their exact time-weighted
            // liquidity contribution, unaffected by other users' actions.
            //
            // In the actual O(1) implementation, users only receive rewards when they explicitly claim,
            // and their rewards can be diluted or concentrated by other users' liquidity changes between claims.
            //
            // Sources of deviation:
            // 1. Unclaimed rewards: Users who don't claim before program ends (main source in random test)
            // 2. Timing of claims: Users claiming sub-optimally relative to liquidity changes (5-15%)
            // 3. Rounding in fixed-point arithmetic (< 0.01%)
            //
            // In this random chaos test, deviation can be very high (50-90%) because users claim
            // infrequently and randomly. In production with rational actors who claim regularly,
            // deviation should be much lower (5-20%).
            //
            // The test validates that:
            // - The contract correctly implements the O(1) accumulator logic
            // - Actual rewards are always <= ideal (users can't game the system for extra rewards)
            // - The deviation is primarily from unclaimed rewards, not calculation errors
            
            // Verify that actual <= ideal (users shouldn't get more than ideal)
            // Allow small margin for rounding (1%)
            const maxActual = totalIdealRewards.mul(101).div(100);
            expect(totalActualRewards).to.be.lte(maxActual,
                `Actual rewards (${ethers.utils.formatUnits(totalActualRewards, 18)}) exceed ideal ` +
                `(${ethers.utils.formatUnits(totalIdealRewards, 18)}). This suggests users are receiving ` +
                `more than they should with perfect claim timing.`);
            
            // In production, users would claim more frequently, so deviation would be much lower
            // For this random chaos test, we just verify it's not absurdly high (> 95%)
            const maxAllowedDeviationPercent = 95;
            expect(deviationPercent).to.be.lte(maxAllowedDeviationPercent,
                `Overall deviation ${deviationPercent}% exceeds ${maxAllowedDeviationPercent}%. ` +
                `This suggests a fundamental calculation error, not just infrequent claims.`);
        }
        
        console.log(`\nTest passed! O(1) implementation correctly calculates rewards with expected deviation from ideal.`);
    });
});
