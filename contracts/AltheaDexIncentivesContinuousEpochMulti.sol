// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.28;

import "./mixins/StorageLayout.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";

/** @title  Althea Dex Continuous Per-Block Multi Token Incentives contract
 *  @notice This contract provides per-block liquidity x time weighted incentives for concentrated and ambient liquidity on the iFi Dex.
 *
 *          Narrative design explanation:
 *          The unique design of this incentives contract is that it's entierly separate from the dex itself, this means that there is no
 *          risk of a flaw in this contract compromising the dex's core functionality. But the downside of this is that the incentives can
 *          not expect to be called every time the dex is and therefore must operate on limited information.
 * 
 *          In order to receive rewards from a program, users must first register their liquidity position.
 *          This snapshots the current state of the global accumulator for that liquidity for pool and reward token. They must
 *          not modify their liquidity position while participating in the program, and they can claim at any time.
 *          When claiming, rewards are calculated and immediately transferred to the user. If a position is modified,
 *          the user must re-register to start accumulating rewards again.
 * 
 *          Since we can't update every users accumulator on every dex interaction there is some risk of 'inaccuracy' where rewards
 *          where a user loses potential rewards because they did not claim during and a signficiant amount of new liquidity was added to the pool
 *          resulting in them recieving rewards as if they had the smaller share for the entire time between their last claim and the current claim.
 *          The impact of this is mitigated by allowing any user to claim on behalf of another user in exchange for a portion of the rewards claimed. This caps
 *          the maximum loss to any user to 1% of their total rewards, while incentivising active claiming to reduce the impact of this effect to the point
 *          where it is negligible.
 * 
 *          Thanks to the rule that the user can not modify their lp positon without forfeiting their rewards it's not possible for the program to overpay a
 *          user as liquidity decreases in the same way a user can be underpaid as liquidity increases. This means programs can have a predictable maximum cost
 *          at creation time and the rewards contract can enforce that programs are always fully funded when created or modified. Tokens will be left over
 *          at the end of a program and can be recycled into new programs directly or withdrawn by the owner.
 * 
 *          Governance is the expected owner of this contract. Specifically on Althea L1 this is chain wide governance votes. Meaning functionality like 'pause' or
 *          other emergency controls would mostly be too slow to be useful, so the focus is on secure and predictable operation.
 * 
 *          All programs must have a defined end block at creation at which point they automatically deactivate. In contract accounting keeps track of total committed future rewards
 *          across all programs and tokens. This allows the contract to accept direct token deposits or leftover funds from completed programs, so when a program is created or modified
 *          excess tokens in the contract balance are used to compute what the end block should be. End block is not an argument to program creation/modification functions, instead it is
 *          derived from the funding available, either sent to the contract or included in the create/modify call itself. 
 * 
 *          In order to handle program deactivation and re-activation we use an epoch number stored in both the user reward info and the program info.
 *
 *          Programs become deactivated either by the admin or at their end block. Funding may or may not remain at this point depending on if users claimed all their rewards. Using the programs end
 *          block users can claim any remaining rewards up to that block even after deactivation. Programs can be re-activated later by calling create/modify again, this increments the epoch number.
 *          When a program is re-activated rewards from the old program are no longer claimable and those tokens are removed from the committed total and allowed to be used again.
 * 
 *          Users must re-register, updating their epoch number to accumulate rewards from the resumed program. This handling means we can have a single reward program per pool/token/liquidity type
 *          that can be paused and resumed without requiring complex tracking of multiple programs. This would usually imply significant risk to the user of lost rewards if they fail to claim in time
 *          or fail to re-register when the program resumes.
 *  
 *          Combining delegated claiming with delegated registering (where a third party registers on behalf of a user) allows for essentially optimal user behavior, from the user's perspective
 *          they deposit into the dex and rewards just show up in their wallet over time with no action required on their part. Since an ecosystem of bots continuously claim and re-register them
 *          There is no rewards for delegated registering since it's assumed that the gas cost of registering is negligible compared to the rewards earned over time by the delegated claimer ecosystem.
 *          of course this is a tragedy of the commons where the bot operators who register users pay a fee but do not get any direct reward. In practice we hope this is negligable or users register themselves.
 * 
 *          The emergencyWithdraw function is intentionally difficult to use, the admin will have to first deacitvate all programs and create new ones with zero reward rates to free up committed funds that can
 *          then be withdrawn. This ensures that under normal operation there is no risk of admin draining funds from active programs. Since the admin is governance we're not really concerned about the possibility
 *          of malicious behavior on the admins part. All actions will go through large scale votes.
 * 
 *          Summary of Features:
 *           Key properties:
 *          - Fixed reward rate per block (predictable spending), this represents the maximum rate at which rewards are distributed
 *            the actual rate may be lower depending on how users claim.
 *          - Delegated claiming and registering allows us to assume essentially optimal user behavior without requiring every user to be active.
 *          - Rewards proportional to share of pool liquidity registered for rewards of that token type provided over time
 *          - O(1) complexity for all operations (register, claim, accumulator update)
 *          - Support for multiple reward tokens per pool
 *          - Support for both concentrated and ambient liquidity
 *          - Support for both ERC20 and native token rewards
 * 
 *          Mathematical Model:
 *          Each block distributes R tokens among all liquidity providers proportionally.
 *          We maintain a global accumulator G that increases by R/L each block (where L = total pool liquidity registered for incentives).
 *          When a user registers, we snapshot G as G1.
 *          When a user claims, current G is G2.
 *          User rewards = user_liquidity * (G2 - G1)
 * 
 *          User Flow:
 *          1. User provides liquidity to a pool
 *          2. User calls register() to start tracking rewards (snapshots current accumulator state)
 *          3. User waits for blocks to pass
 *          4. User calls claimRewards() to calculate and receive tokens immediately, or receives tokens in their wallet passively
 *             as a 3rd party claims on their behalf for a portion of the rewards.
 *          5. If user modifies liquidity, they can claim first, then register again after modification
 *             it is possible for a program to end with excess funds, which can be recovered via emergencyWithdraw.
 *             but it should not be possible for a program to be underfunded.
 * 
 *          Admin Flow:
 *          - The admin is assumed to be a large multisig or a governance vote system. This means 'pause' or other
 *            emergency controls would mostly be too slow to be useful, so the focus is on secure and predictable operation.
 *            and rescue operations that are not time sensitive.
 *          - Admin creates/modifies reward programs by calling createOrModifyProgram().
 *          - Changes to rewardPerBlock take effect immediately at the next accumulator update.
 *          - Programs automatically become exhausted when funding runs out and can be renewed by
 *          - calling createOrModifyProgram() again with additional funding.
 * 
 *          Compatible tokens:
 *          - No rebasing, mint-on-transfer, or deflationary tokens. Only standard ERC20 and native tokens are supported.
 * 
 *    */
contract AltheaDexIncentivesContinuousEpochMulti is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using Address for address payable;

    /// @notice Precision multiplier for fixed-point arithmetic (1e18)
    uint256 public constant PRECISION = 1e18;

    /// @notice Any third party claiming on behalf of a user will receive this portion of the rewards (in basis points)
    ///         admin can update this value to account for changing gas costs. 
    uint256 public DELEGATED_CLAIM_FEE_BASIS_POINTS = 100; // 1%

    /// @notice Basis points denominator (10000 = 100%)
    uint256 public constant BASIS_POINTS = 10000;

    /// @notice The Althea DEX contract providing liquidity accumulators
    StorageLayout public immutable altheaDexAddress;

    /// @notice Receive function to accept native token deposits for rewards
    receive() external payable {}

    /** @notice Reward program configuration for a specific pool and reward token
     *  @dev Separate programs exist for concentrated vs ambient liquidity
     */
    struct RewardProgram {
        address rewardToken;                    // ERC20 token address (address(0) for native token)
        uint256 rewardPerBlock;                 // Amount of rewardToken distributed per block
        uint256 lastUpdateBlock;                // Block number of last accumulator update
        uint256 rewardPerLiquidityAccumulator;  // Cumulative rewards per liquidity unit (scaled by PRECISION)
        uint256 endBlock;                       // Block number when program ends, ideally no funds remain, possibly some do
        uint256 totalRegisteredLiquidity;       // Total liquidity registered for rewards (not total pool liquidity)
        uint256 epoch;                          // Epoch number, incremented on each reactivation after deactivation
    }

    /** @notice User reward tracking for a specific pool and reward token
     *  @dev Tracks user's snapshot of accumulator and liquidity state
     */
    struct UserRewardInfo {
        uint256 userRewardPerLiquiditySnapshot; // User's snapshot of rewardPerLiquidityAccumulator
        uint256 userLiqAddedSnapshot;           // User's liquidity added at registration
        uint256 userLiqRemovedSnapshot;         // User's liquidity removed at registration
        bool registered;                        // Whether user has registered
        uint256 epoch;                          // Epoch at which user registered
    }

    // poolId => rewardToken => ConcentratedRewardProgram
    mapping(bytes32 => mapping(address => RewardProgram)) public concentratedPrograms;

    // poolId => rewardToken => AmbientRewardProgram
    mapping(bytes32 => mapping(address => RewardProgram)) public ambientPrograms;

    // user => poolId => rewardToken => concentrated UserRewardInfo
    mapping(address => mapping(bytes32 => mapping(address => UserRewardInfo))) public userConcRewardInfo;

    // user => poolId => rewardToken => ambient UserRewardInfo
    mapping(address => mapping(bytes32 => mapping(address => UserRewardInfo))) public userAmbRewardInfo;

    // Track total committed future rewards per token across all programs
    // This represents the sum of (remainingBlocks * rewardPerBlock) for all active programs
    // As blocks pass and _updateAccumulator is called, this value decreases
    // Available balance = contract balance - totalCommittedRewards
    // This allows the contract to use leftover funds from completed programs or directly sent tokens
    mapping(address => uint256) public totalCommittedRewards;

    // Events
    event ProgramCreated(
        bytes32 indexed poolId,
        address indexed rewardToken,
        bool indexed isConcentrated,
        uint256 rewardPerBlock,
        uint256 endBlock
    );

    event ProgramModified(
        bytes32 indexed poolId,
        address indexed rewardToken,
        bool indexed isConcentrated,
        uint256 newRewardPerBlock,
        uint256 newEndBlock
    );

    event ProgramDeactivated(
        bytes32 indexed poolId,
        address indexed rewardToken,
        bool indexed isConcentrated
    );

    event FirstRegistration(
        address indexed user,
        bytes32 indexed poolId,
        address indexed rewardToken,
        bool isConcentrated,
        address registrar
    );

    event Registration(
        address indexed user,
        bytes32 indexed poolId,
        address indexed rewardToken,
        bool isConcentrated,
        address registrar
    );

    event ClaimedRewards(
        address indexed user,
        bytes32 indexed poolId,
        address indexed rewardToken,
        bool isConcentrated,
        uint256 amount,
        address claimer,
        uint256 claimerFee
    );

    event AccumulatorUpdated(
        bytes32 indexed poolId,
        address indexed rewardToken,
        bool indexed isConcentrated,
        uint256 blocksPassed,
        uint256 newAccumulator,
        uint256 totalRegisteredLiquidity,
        uint256 rewardPerBlock
    );

    event EmergencyWithdrawal(
        address indexed token,
        address indexed destination,
        uint256 amount
    );

    event ProgramFundingExhausted(
        bytes32 indexed poolId,
        address indexed rewardToken,
        bool indexed isConcentrated,
        uint256 totalRegisteredLiquidity
    );

    event DelegatedClaimFeeUpdated(
        uint256 oldFee,
        uint256 newFee
    );

    event ProgramEpochIncremented(
        bytes32 indexed poolId,
        address indexed rewardToken,
        bool indexed isConcentrated,
        uint256 newEpoch
    );

    constructor(address _altheaDexAddress, address _owner) {
        require(_altheaDexAddress != address(0), "Invalid DEX address");
        altheaDexAddress = StorageLayout(_altheaDexAddress);

        if (_owner != address(0)) {
            transferOwnership(_owner);
        }
    }

    // ============ Common User Functions ============

    /// @notice Register for rewards (handles both initial registration and re-registration automatically)
    /// @dev Smart function that:
    ///      - Registers if not already registered
    ///      - Re-registers if liquidity has changed (forfeits pending rewards)
    ///      - No-ops (succeeds) if already registered with unchanged liquidity
    ///      - Supports delegated registration: anyone can register on behalf of another user
    /// @param user The user to register (use msg.sender for self-registration, or another address for delegated registration)
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    function register(
        address user,
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external nonReentrant {
        require(user != address(0), "Invalid user address");
        _registerInternal(user, poolId, rewardToken, isConcentrated, msg.sender);
    }

    /// @notice Claim rewards (calculates and transfers rewards)
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    function claimRewards(
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external nonReentrant {
        _claimRewardsInternal(msg.sender, msg.sender, poolId, rewardToken, isConcentrated);
    }

    /// @notice Claim rewards on behalf of another user (delegated claim)
    /// @dev The claimer receives DELEGATED_CLAIM_FEE_BASIS_POINTS of the rewards as compensation
    /// @param user The user whose rewards to claim
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    function claimRewardsOnBehalfOf(
        address user,
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external nonReentrant {
        require(user != address(0), "Invalid user address");
        require(user != msg.sender, "Use claimRewards for self-claim");
        _claimRewardsInternal(user, msg.sender, poolId, rewardToken, isConcentrated);
    }

    // ============ Query Functions ============

    /// @notice View function: get pending rewards for a user
    /// @param poolId The pool identifier
    /// @param user The user address
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    /// @return The amount of pending rewards
    function getPendingRewards(
        address user,
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external view returns (uint256) {
        return _getPendingRewardsInternal(poolId, user, rewardToken, isConcentrated);
    }

    /// @notice View function: get potential tip for a delegated claimer
    /// @dev This calculates only the fee portion (DELEGATED_CLAIM_FEE_BASIS_POINTS)
    ///      that would go to a third-party claimer if they claimed on behalf of the user
    /// @param user The user address whose rewards would be claimed
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    /// @return The amount of potential tip for the claimer
    function getPotentialTip(
        address user,
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external view returns (uint256) {
        uint256 totalPendingRewards = _getPendingRewardsInternal(poolId, user, rewardToken, isConcentrated);
        if (totalPendingRewards == 0) {
            return 0;
        }
        return (totalPendingRewards * DELEGATED_CLAIM_FEE_BASIS_POINTS) / BASIS_POINTS;
    }

    /// @notice View function: get program information
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    /// @return program The reward program details
    function getProgramInfo(
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external view returns (RewardProgram memory) {
        return _getProgram(poolId, rewardToken, isConcentrated);
    }

    /// @notice View function: check if a program is currently active and funded
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    /// @return True if the program is active and not exhausted
    function isProgramActive(
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external view returns (bool) {
        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);
        return _isProgramActive(program);
    }

    /// @notice View function: get remaining blocks for a program
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    /// @return remainingBlocks The number of blocks remaining (0 if exhausted)
    function getRemainingBlocks(
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external view returns (uint256 remainingBlocks) {
        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);
        if (_isFundingExhausted(program) || program.rewardPerBlock == 0) {
            return 0;
        }
        return program.endBlock - block.number;
    }

    /// @notice View function: get remaining reward tokens for a program
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    /// @return remainingRewards The amount of reward tokens remaining to be distributed
    function getRemainingRewards(
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external view returns (uint256 remainingRewards) {
        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);
        if (_isFundingExhausted(program) || program.rewardPerBlock == 0) {
            return 0;
        }
        uint256 remainingBlocks = program.endBlock - block.number;
        return remainingBlocks * program.rewardPerBlock;
    }

    /// @notice View function: get user registration status
    /// @param user The user address
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    /// @return registered Whether the user is registered
    /// @return pendingRewards The user's pending rewards
    /// @return userLiquidity The user's net liquidity at registration
    function getUserInfo(
        address user,
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external view returns (
        bool registered,
        uint256 pendingRewards,
        uint256 userLiquidity
    ) {
        UserRewardInfo storage userInfo = _getUserInfo(user, poolId, rewardToken, isConcentrated);
        registered = userInfo.registered;
        pendingRewards = _getPendingRewardsInternal(poolId, user, rewardToken, isConcentrated);
        if (userInfo.userLiqAddedSnapshot > userInfo.userLiqRemovedSnapshot) {
            userLiquidity = userInfo.userLiqAddedSnapshot - userInfo.userLiqRemovedSnapshot;
        } else {
            userLiquidity = 0;
        }
    }

    /// @notice View function: get available balance for a reward token
    /// @dev Returns balance minus committed rewards
    /// @param rewardToken The reward token address (address(0) for native)
    /// @return availableBalance The available balance for new programs
    function getAvailableBalance(
        address rewardToken
    ) external view returns (uint256 availableBalance) {
        uint256 totalBalance;
        if (rewardToken == address(0)) {
            totalBalance = address(this).balance;
        } else {
            totalBalance = IERC20(rewardToken).balanceOf(address(this));
        }

        uint256 committed = totalCommittedRewards[rewardToken];
        if (totalBalance > committed) {
            return totalBalance - committed;
        }
        return 0;
    }

    /// @notice View function: get comprehensive program status
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    /// @return active Whether the program is active
    /// @return fundingExhausted Whether funding is exhausted
    /// @return currentBlock The current block number
    /// @return lastUpdateBlock The last update block
    /// @return endBlock The end block
    /// @return remainingBlocks The number of remaining blocks
    /// @return remainingRewards The amount of remaining rewards
    function getProgramStatus(
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external view returns (
        bool active,
        bool fundingExhausted,
        uint256 currentBlock,
        uint256 lastUpdateBlock,
        uint256 endBlock,
        uint256 remainingBlocks,
        uint256 remainingRewards
    ) {
        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);
        active = _isProgramActive(program);
        fundingExhausted = _isFundingExhausted(program);
        currentBlock = block.number;
        lastUpdateBlock = program.lastUpdateBlock;
        endBlock = program.endBlock;

        if (_isFundingExhausted(program) || program.rewardPerBlock == 0) {
            remainingBlocks = 0;
            remainingRewards = 0;
        } else {
            remainingBlocks = program.endBlock - block.number;
            remainingRewards = remainingBlocks * program.rewardPerBlock;
        }
    }

    /// @notice View function: check if a user needs to re-register for a reward program
    /// @dev Returns true if any of the following conditions are met:
    ///      1. User is not registered at all
    ///      2. User is registered in an old epoch (program was deactivated and reactivated)
    ///      3. User's liquidity position has changed since registration
    ///      Returns false if program doesn't exist or user is properly registered with unchanged liquidity
    /// @param user The user address to check
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    /// @return True if the user needs to re-register, false otherwise
    function needsReregistration(
        address user,
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external view returns (bool) {
        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);

        // If program doesn't exist or isn't active, no point in registering
        if (program.rewardPerBlock == 0 || !_isProgramActive(program)) {
            return false;
        }

        UserRewardInfo storage userInfo = _getUserInfo(user, poolId, rewardToken, isConcentrated);

        // If not registered at all, needs to register
        if (!userInfo.registered) {
            return true;
        }

        // If registered in old epoch, needs to re-register for current epoch
        if (userInfo.epoch < program.epoch) {
            return true;
        }

        // Check if liquidity has changed since registration
        (uint256 currentAdded, uint256 currentRemoved) = _getUserLiquidityAccumulators(user, poolId, isConcentrated);

        if (currentAdded != userInfo.userLiqAddedSnapshot || currentRemoved != userInfo.userLiqRemovedSnapshot) {
            return true;
        }

        // User is properly registered with unchanged liquidity
        return false;
    }

    // ============  Admin Functions =============

    /// @notice Owner-only: Creates or modifies a reward program
    /// @dev IMPORTANT: Funding must be provided in the same transaction:
    ///      - For ERC20 tokens: Approve this contract first, tokens will be pulled during this call
    ///      - For native tokens: Send value with this transaction (payable)
    ///      This ensures programs are always fully funded and prevents underfunded programs.
    ///      Any excess funding at program end can be recovered via emergencyWithdraw.
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address (address(0) for native)
    /// @param rewardPerBlock Amount of rewards distributed per block
    /// @param fundingAmount Amount of tokens to fund the program with (0 for modifications that don't add funding)
    /// @param isConcentrated True for concentrated liquidity, false for ambient liquidity
    function createOrModifyProgram(
        bytes32 poolId,
        address rewardToken,
        uint256 rewardPerBlock,
        uint256 fundingAmount,
        bool isConcentrated
    ) external payable onlyOwner {
        _createOrModifyProgramInternal(poolId, rewardToken, rewardPerBlock, fundingAmount, isConcentrated);
    }

    /// @notice Owner-only: Deactivates a program (no new registrations, existing users can still claim)
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated, false for ambient
    function deactivateProgram(
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) external onlyOwner {
        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);

        require(program.rewardPerBlock > 0, "Program does not exist");

        // Update accumulator one last time if program is still active
        if (_isProgramActive(program)) {
            _updateAccumulator(program, poolId, isConcentrated);
        }

        // Release any remaining committed rewards
        // This handles both:
        // 1. Active programs with future blocks remaining
        // 2. Expired programs with stale commitment (lastUpdateBlock < endBlock)
        if (program.lastUpdateBlock < program.endBlock) {
            // Calculate commitment for blocks that haven't been accounted for
            uint256 remainingBlocks = program.endBlock - program.lastUpdateBlock;
            uint256 staleCommitment = remainingBlocks * program.rewardPerBlock;

            if (totalCommittedRewards[rewardToken] >= staleCommitment) {
                totalCommittedRewards[rewardToken] -= staleCommitment;
            } else {
                // Should not happen, but safeguard against underflow
                totalCommittedRewards[rewardToken] = 0;
            }

            // Update lastUpdateBlock to endBlock to mark that we've released the commitment
            program.lastUpdateBlock = program.endBlock;
        }

        // Set endBlock to current block to deactivate the program
        program.endBlock = block.number;
        emit ProgramDeactivated(poolId, rewardToken, isConcentrated);
    }

    /// @notice Owner-only: Update the delegated claim fee
    /// @param newFeeBasisPoints The new fee in basis points (100 = 1%)
    function updateDelegatedClaimFee(uint256 newFeeBasisPoints) external onlyOwner {
        require(newFeeBasisPoints <= BASIS_POINTS, "Fee exceeds 100%");
        uint256 oldFee = DELEGATED_CLAIM_FEE_BASIS_POINTS;
        DELEGATED_CLAIM_FEE_BASIS_POINTS = newFeeBasisPoints;
        emit DelegatedClaimFeeUpdated(oldFee, newFeeBasisPoints);
    }

    /// @notice Emergency function to withdraw stuck tokens or native tokens
    /// @dev Only allows withdrawing tokens that are not committed to active or paused programs.
    ///      Admin must first deactivate programs or wait for them to expire. Then create a new program
    ///      (blocking claiming from the old program) to free up committed funds before withdrawing
    ///      This ensures admin cannot drain funds that may still be claimable by users.
    /// @param token Token address (address(0) for native)
    /// @param destination Recipient address
    /// @param amount Amount to withdraw
    function emergencyWithdraw(
        address token,
        address destination,
        uint256 amount
    ) external onlyOwner {
        require(destination != address(0), "Zero destination");
        require(amount > 0, "Zero amount");

        // Get current balance
        uint256 currentBalance;
        if (token == address(0)) {
            currentBalance = address(this).balance;
        } else {
            currentBalance = IERC20(token).balanceOf(address(this));
        }

        // Calculate available balance (total balance minus committed future rewards)
        uint256 committed = totalCommittedRewards[token];
        require(currentBalance >= committed, "Insufficient balance for committed rewards");
        uint256 availableBalance = currentBalance - committed;

        // Can only withdraw from available balance
        require(amount <= availableBalance, "Exceeds available balance");

        if (token == address(0)) {
            payable(destination).sendValue(amount);
        } else {
            IERC20(token).safeTransfer(destination, amount);
        }

        emit EmergencyWithdrawal(token, destination, amount);
    }

    // ============ Internal Functions ============

    /// @dev Get the correct program storage based on liquidity type
    function _getProgram(
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) internal view returns (RewardProgram storage) {
        return isConcentrated
            ? concentratedPrograms[poolId][rewardToken]
            : ambientPrograms[poolId][rewardToken];
    }

    /// @dev Get the correct user info storage based on liquidity type
    function _getUserInfo(
        address user,
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) internal view returns (UserRewardInfo storage) {
        return isConcentrated
            ? userConcRewardInfo[user][poolId][rewardToken]
            : userAmbRewardInfo[user][poolId][rewardToken];
    }

    /// @dev Get user's liquidity accumulators from DEX
    function _getUserLiquidityAccumulators(
        address user,
        bytes32 poolId,
        bool isConcentrated
    ) internal view returns (uint256 added, uint256 removed) {
        if (isConcentrated) {
            added = altheaDexAddress.incentiveUserPoolConcLiqAddedAccumulators(user, poolId);
            removed = altheaDexAddress.incentiveUserPoolConcLiqRemovedAccumulators(user, poolId);
        } else {
            added = altheaDexAddress.incentiveUserPoolAmbLiqAddedAccumulators(user, poolId);
            removed = altheaDexAddress.incentiveUserPoolAmbLiqRemovedAccumulators(user, poolId);
        }
    }

    /// @dev Get pool's total liquidity accumulators from DEX
    function _getPoolLiquidityAccumulators(
        bytes32 poolId,
        bool isConcentrated
    ) internal view returns (uint256 added, uint256 removed) {
        if (isConcentrated) {
            added = altheaDexAddress.incentivePoolConcLiqAddedAccumulators(poolId);
            removed = altheaDexAddress.incentivePoolConcLiqRemovedAccumulators(poolId);
        } else {
            added = altheaDexAddress.incentivePoolAmbLiqAddedAccumulators(poolId);
            removed = altheaDexAddress.incentivePoolAmbLiqRemovedAccumulators(poolId);
        }
    }

    /// @dev Check if a program's funding is exhausted (past end block)
    /// @param program The reward program to check
    /// @return True if current block is at or past the program's end block
    function _isFundingExhausted(RewardProgram storage program) internal view returns (bool) {
        return block.number >= program.endBlock;
    }

    /// @dev Check if a program is active (exists and not exhausted)
    /// @param program The reward program to check
    /// @return True if program exists and has not reached its end block
    function _isProgramActive(RewardProgram storage program) internal view returns (bool) {
        return program.rewardPerBlock > 0 && !_isFundingExhausted(program);
    }

    /// @dev Internal: Unified logic for creating or modifying a reward program
    /// @dev Accounting model:
    ///      - totalCommittedRewards tracks future obligations (sum of remainingBlocks * rewardPerBlock for all programs)
    ///      - Contract balance includes: unclaimed rewards + committed future rewards + uncommitted tokens
    ///      - Available for new programs = balance - totalCommittedRewards
    ///      - When blocks pass (via _updateAccumulator), totalCommittedRewards decreases
    ///      - When programs are deactivated, remaining commitments are released
    ///      - This allows reusing leftover funds from completed programs and directly sent tokens
    function _createOrModifyProgramInternal(
        bytes32 poolId,
        address rewardToken,
        uint256 rewardPerBlock,
        uint256 fundingAmount,
        bool isConcentrated
    ) internal {
        require(poolId != bytes32(0), "Zero pool ID");
        require(rewardPerBlock > 0, "Zero reward per block");

        // Handle funding based on token type
        if (rewardToken == address(0)) {
            // Native token: must send value with transaction
            require(msg.value == fundingAmount, "Native funding mismatch");
        } else {
            // ERC20: pull tokens from sender if funding amount specified
            require(msg.value == 0, "Cannot send native tokens for ERC20 program");
            if (fundingAmount > 0) {
                IERC20(rewardToken).safeTransferFrom(msg.sender, address(this), fundingAmount);
            }
        }

        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);
        bool isNew = program.rewardPerBlock == 0;
        bool wasDeactivated = false;

        // Check if program was previously deactivated (has rewardPerBlock but funding exhausted)
        if (!isNew && _isFundingExhausted(program)) {
            wasDeactivated = true;
        }

        // Update accumulator first if program exists and not deactivated
        // This ensures lastUpdateBlock is current before we calculate new endBlock
        // For deactivated programs, we'll handle the stale commitment below
        if (!isNew && !wasDeactivated) {
            _updateAccumulator(program, poolId, isConcentrated);
        }

        // Calculate old commitment AFTER updating accumulator
        uint256 oldCommitment = 0;
        if (!isNew && !_isFundingExhausted(program)) {
            // Active program: calculate remaining commitment after accumulator update
            uint256 remainingBlocks = program.endBlock - program.lastUpdateBlock;
            oldCommitment = remainingBlocks * program.rewardPerBlock;
        } else if (wasDeactivated) {
            // Exhausted program being reactivated
            // We need to release any stale commitment that was never freed due to lack of accumulator updates
            // This handles the case where program expired without anyone triggering _updateAccumulator

            // First, update the accumulator to the endBlock to free up committed funds for blocks that passed
            // This simulates what would have happened if someone had called an update function
            if (program.lastUpdateBlock < program.endBlock) {
                uint256 unupdatedBlocks = program.endBlock - program.lastUpdateBlock;
                uint256 staleCommitment = unupdatedBlocks * program.rewardPerBlock;

                // Release the stale commitment from totalCommittedRewards
                // This represents blocks that passed but were never accounted for
                if (totalCommittedRewards[rewardToken] >= staleCommitment) {
                    totalCommittedRewards[rewardToken] -= staleCommitment;
                } else {
                    // Should not happen, but safeguard against underflow
                    totalCommittedRewards[rewardToken] = 0;
                }

                // Update lastUpdateBlock to endBlock to mark that we've accounted for all blocks
                program.lastUpdateBlock = program.endBlock;
            }

            // After cleanup, oldCommitment is 0 since the program is exhausted and we've released stale funds
            oldCommitment = 0;
        }

        // If reactivating a deactivated program, increment epoch and release old commitments
        if (wasDeactivated) {
            program.epoch += 1;

            // Reset accumulator and registered liquidity for new epoch
            program.rewardPerLiquidityAccumulator = 0;
            program.totalRegisteredLiquidity = 0;

            emit ProgramEpochIncremented(poolId, rewardToken, isConcentrated, program.epoch);
        }

        // Calculate available balance for this reward token
        uint256 availableBalance;
        if (rewardToken == address(0)) {
            availableBalance = address(this).balance;
        } else {
            availableBalance = IERC20(rewardToken).balanceOf(address(this));
        }

        // Subtract already committed rewards (future commitments from all programs)
        uint256 committed = totalCommittedRewards[rewardToken];
        // Add back this program's old commitment since we're replacing it
        if (oldCommitment > 0) {
            committed -= oldCommitment;
        }
        require(availableBalance >= committed, "Insufficient balance for existing commitments");
        availableBalance -= committed;

        // Calculate how many blocks this program can run with available balance
        uint256 fundedBlocks = availableBalance / rewardPerBlock;
        require(fundedBlocks > 0, "Insufficient funding for at least one block");

        // Calculate end block based on funding
        // Always use current block as start to prevent over-commitment from stale lastUpdateBlock
        uint256 startBlock = block.number;
        uint256 endBlock = startBlock + fundedBlocks;

        // Calculate new commitment
        uint256 newCommitment = fundedBlocks * rewardPerBlock;

        // Update global commitment tracking
        if (oldCommitment > 0) {
            totalCommittedRewards[rewardToken] -= oldCommitment;
        }
        totalCommittedRewards[rewardToken] += newCommitment;

        // Set or update program parameters
        if (isNew) {
            program.rewardToken = rewardToken;
            program.lastUpdateBlock = block.number;
            program.epoch = 1; // Start at epoch 1
            emit ProgramCreated(poolId, rewardToken, isConcentrated, rewardPerBlock, endBlock);
            emit ProgramEpochIncremented(poolId, rewardToken, isConcentrated, program.epoch);
        } else {
            // For modifications, lastUpdateBlock was already updated by _updateAccumulator above
            // Or set to current block for reactivations
            if (wasDeactivated) {
                program.lastUpdateBlock = block.number;
            }
            emit ProgramModified(poolId, rewardToken, isConcentrated, rewardPerBlock, endBlock);
        }

        program.rewardPerBlock = rewardPerBlock;
        program.endBlock = endBlock;
    }

    /// @dev Internal: Smart registration logic that handles both initial registration and re-registration
    /// @notice Automatically determines whether to register, re-register, or no-op based on current state
    /// @dev - If not registered: registers the user
    ///      - If already registered with unchanged liquidity: no-op (success)
    ///      - If already registered with changed liquidity: re-registers (forfeits pending rewards)
    ///      - If registered in old epoch: re-registers for new epoch (forfeits old epoch rewards)
    /// @param user The user to register (can be msg.sender or another address for delegated registration)
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated, false for ambient
    /// @param registrar The address performing the registration (msg.sender)
    function _registerInternal(
        address user,
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated,
        address registrar
    ) internal {
        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);
        require(program.rewardPerBlock > 0, "Program does not exist");
        require(_isProgramActive(program), "Program not active");

        // Update accumulator to latest before checking user's state
        // This ensures the accumulator is up-to-date for reward calculations
        _updateAccumulator(program, poolId, isConcentrated);

        // Check if program has funding after update
        require(!_isFundingExhausted(program), "Program funding exhausted");

        UserRewardInfo storage userInfo = _getUserInfo(user, poolId, rewardToken, isConcentrated);

        // Get current user liquidity from DEX
        (uint256 userAdded, uint256 userRemoved) = _getUserLiquidityAccumulators(user, poolId, isConcentrated);

        // User must have net liquidity
        require(userAdded > userRemoved, "No net liquidity");

        // Check if user is registered in old epoch
        bool oldEpoch = userInfo.registered && userInfo.epoch < program.epoch;

        // If already registered, check if liquidity has changed or epoch changed
        if (userInfo.registered && !oldEpoch) {
            // Check if liquidity has changed
            bool liquidityChanged = (userAdded != userInfo.userLiqAddedSnapshot || userRemoved != userInfo.userLiqRemovedSnapshot);

            // If liquidity hasn't changed, this is a no-op - just return success
            if (!liquidityChanged) {
                return; // No-op: already registered with same liquidity in current epoch
            }

            // Liquidity has changed - perform re-registration
            // Get OLD user liquidity to remove from total
            uint256 oldUserNetLiq = userInfo.userLiqAddedSnapshot - userInfo.userLiqRemovedSnapshot;
            uint256 newUserNetLiq = userAdded - userRemoved;

            // Update total registered liquidity (remove old, add new)
            program.totalRegisteredLiquidity = program.totalRegisteredLiquidity - oldUserNetLiq + newUserNetLiq;

            // Update snapshots to current state - this resets reward tracking
            // Any rewards accrued since last claim are forfeited
            userInfo.userRewardPerLiquiditySnapshot = program.rewardPerLiquidityAccumulator;
            userInfo.userLiqAddedSnapshot = userAdded;
            userInfo.userLiqRemovedSnapshot = userRemoved;
            userInfo.epoch = program.epoch; // Update to current epoch

            emit Registration(user, poolId, rewardToken, isConcentrated, registrar);
            return;
        }

        // Handle registration in old epoch or first time registration
        if (oldEpoch) {
            // User was registered in old epoch
            // Note: totalRegisteredLiquidity was reset to 0 when epoch incremented,
            // so we don't subtract the old liquidity
            emit Registration(user, poolId, rewardToken, isConcentrated, registrar);
        } else {
            // First time registration - emit both events
            emit FirstRegistration(user, poolId, rewardToken, isConcentrated, registrar);
            emit Registration(user, poolId, rewardToken, isConcentrated, registrar);
        }

        // Register/re-register for current epoch
        uint256 userNetLiq = userAdded - userRemoved;

        // Record snapshots - snapshot the accumulator for reward calculation
        userInfo.userRewardPerLiquiditySnapshot = program.rewardPerLiquidityAccumulator;
        userInfo.userLiqAddedSnapshot = userAdded;
        userInfo.userLiqRemovedSnapshot = userRemoved;
        userInfo.registered = true;
        userInfo.epoch = program.epoch; // Set to current epoch

        // Add user's liquidity to total registered liquidity
        program.totalRegisteredLiquidity += userNetLiq;
    }

    /// @dev Internal: Unified claim logic (calculates and transfers rewards in one operation)
    /// @param user The user whose rewards to claim
    /// @param claimer The address claiming the rewards (msg.sender for self-claim, or delegate for third-party claim)
    /// @param poolId The pool identifier
    /// @param rewardToken The reward token address
    /// @param isConcentrated True for concentrated, false for ambient
    function _claimRewardsInternal(
        address user,
        address claimer,
        bytes32 poolId,
        address rewardToken,
        bool isConcentrated
    ) internal {
        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);
        require(program.rewardPerBlock > 0, "Program does not exist");

        // Update accumulator to latest
        _updateAccumulator(program, poolId, isConcentrated);

        UserRewardInfo storage userInfo = _getUserInfo(user, poolId, rewardToken, isConcentrated);
        require(userInfo.registered, "Not registered");

        // Check if user is registered in current epoch
        require(userInfo.epoch == program.epoch, "User registered in old epoch, must re-register");

        // Get current user liquidity from DEX
        (uint256 currentAdded, uint256 currentRemoved) = _getUserLiquidityAccumulators(user, poolId, isConcentrated);

        // Verify liquidity hasn't changed since registration
        require(currentAdded == userInfo.userLiqAddedSnapshot, "Liquidity changed");
        require(currentRemoved == userInfo.userLiqRemovedSnapshot, "Liquidity changed");

        // Calculate rewards
        uint256 userNetLiq = currentAdded - currentRemoved;
        uint256 rewardPerLiqDelta = program.rewardPerLiquidityAccumulator - userInfo.userRewardPerLiquiditySnapshot;
        uint256 rewards = (userNetLiq * rewardPerLiqDelta) / PRECISION;

        require(rewards > 0, "No rewards to claim");

        // Update snapshot for next claim - user remains registered with same liquidity
        userInfo.userRewardPerLiquiditySnapshot = program.rewardPerLiquidityAccumulator;

        // NOTE: User's liquidity remains in totalRegisteredLiquidity since they're still registered
        // User does NOT need to re-register unless they change their liquidity position

        // Determine if this is a delegated claim
        bool isDelegatedClaim = (user != claimer);
        uint256 claimerFee = 0;

        if (isDelegatedClaim) {
            // Split rewards between user and claimer
            claimerFee = (rewards * DELEGATED_CLAIM_FEE_BASIS_POINTS) / BASIS_POINTS;
            uint256 userAmount = rewards - claimerFee;

            // Transfer rewards
            _transferReward(rewardToken, user, userAmount);
            if (claimerFee > 0) {
                _transferReward(rewardToken, claimer, claimerFee);
            }
        } else {
            // Self-claim: transfer all rewards to user
            _transferReward(rewardToken, user, rewards);
        }

        // Emit unified claim event
        emit ClaimedRewards(user, poolId, rewardToken, isConcentrated, rewards, claimer, claimerFee);
    }

    /// @dev Internal view: Unified pending rewards calculation
    function _getPendingRewardsInternal(
        bytes32 poolId,
        address user,
        address rewardToken,
        bool isConcentrated
    ) internal view returns (uint256) {
        RewardProgram storage program = _getProgram(poolId, rewardToken, isConcentrated);
        UserRewardInfo storage userInfo = _getUserInfo(user, poolId, rewardToken, isConcentrated);

        if (!userInfo.registered || program.rewardPerBlock == 0) {
            return 0;
        }

        // If user is registered in old epoch, they have no pending rewards
        if (userInfo.epoch < program.epoch) {
            return 0;
        }

        // Calculate what the accumulator would be after updating
        uint256 currentAccumulator = _calculateUpdatedAccumulator(program);

        // Get current user liquidity
        (uint256 currentAdded, uint256 currentRemoved) = _getUserLiquidityAccumulators(user, poolId, isConcentrated);

        // If liquidity changed, can't calculate
        if (currentAdded != userInfo.userLiqAddedSnapshot || currentRemoved != userInfo.userLiqRemovedSnapshot) {
            return 0;
        }

        uint256 userNetLiq = currentAdded - currentRemoved;
        uint256 rewardPerLiqDelta = currentAccumulator - userInfo.userRewardPerLiquiditySnapshot;
        uint256 rewards = (userNetLiq * rewardPerLiqDelta) / PRECISION;

        return rewards;
    }

    /// @dev Internal: Update accumulator based on blocks passed (O(1) operation)
    /// @param program The reward program to update
    /// @param poolId The pool identifier
    /// @param isConcentrated True for concentrated, false for ambient
    /// @dev NOTE: This function now uses REGISTERED pool liquidity (tracked by this contract)
    ///      instead of total pool liquidity from the DEX. This provides two key benefits:
    ///      1. Unregistered liquidity does not dilute rewards for registered users
    ///      2. The accumulator automatically updates on every register/claim, reducing deviation
    ///      
    ///      Since users must interact with this contract to register/claim/reregister, and their
    ///      liquidity cannot change without forfeiting rewards, we have perfect knowledge of
    ///      registered liquidity at all times. The accumulator updates whenever ANY user interacts,
    ///      providing much more frequent updates than the previous design.
    function _updateAccumulator(
        RewardProgram storage program,
        bytes32 poolId,
        bool isConcentrated
    ) internal {
        if (program.rewardPerBlock == 0) return;

        // Determine the effective current block (capped at endBlock if past it)
        uint256 effectiveBlock = block.number < program.endBlock ? block.number : program.endBlock;

        // If we've already updated to or past the end block, no more updates needed
        if (program.lastUpdateBlock >= program.endBlock) return;

        // Calculate blocks since update with the effective block
        uint256 blocksSinceUpdate = effectiveBlock - program.lastUpdateBlock;
        if (blocksSinceUpdate == 0) return;

        // Use REGISTERED liquidity instead of total pool liquidity
        uint256 netRegisteredLiq = program.totalRegisteredLiquidity;

        // Update accumulator for passed blocks
        // NOTE: When netRegisteredLiq is 0, rewards for those blocks are not distributed.
        // This is acceptable as there are no registered liquidity providers to reward.
        // The rewards are effectively saved - they reduce the committed amount and can
        // be reclaimed via emergencyWithdraw after program ends.
        if (netRegisteredLiq > 0 && program.rewardPerBlock > 0) {
            // rewardPerLiq is scaled by PRECISION to maintain precision
            uint256 rewardPerLiqPerBlock = (program.rewardPerBlock * PRECISION) / netRegisteredLiq;
            program.rewardPerLiquidityAccumulator += rewardPerLiqPerBlock * blocksSinceUpdate;
        }

        // Decrease committed rewards for blocks that have now passed
        // This frees up funds for new programs as rewards are distributed over time
        uint256 consumedCommitment = blocksSinceUpdate * program.rewardPerBlock;
        if (totalCommittedRewards[program.rewardToken] >= consumedCommitment) {
            totalCommittedRewards[program.rewardToken] -= consumedCommitment;
        } else {
            // Should not happen in normal operation, but safeguard against underflow
            totalCommittedRewards[program.rewardToken] = 0;
        }

        // Update last update block
        program.lastUpdateBlock = effectiveBlock;

        emit AccumulatorUpdated(
            poolId,
            program.rewardToken,
            isConcentrated,
            blocksSinceUpdate,
            program.rewardPerLiquidityAccumulator,
            program.totalRegisteredLiquidity,
            program.rewardPerBlock
        );

        // If we've now reached or passed the end block, emit exhaustion event
        if (program.lastUpdateBlock >= program.endBlock) {
            emit ProgramFundingExhausted(
                poolId, 
                program.rewardToken, 
                isConcentrated,
                program.totalRegisteredLiquidity
            );
        }
    }

    /// @dev Internal view: Calculate what accumulator would be after update (for view functions)
    /// @param program The reward program
    /// @return The calculated accumulator value
    function _calculateUpdatedAccumulator(
        RewardProgram storage program
    ) internal view returns (uint256) {
        if (program.rewardPerBlock == 0) return program.rewardPerLiquidityAccumulator;

        // If already updated past end block, return current accumulator
        if (program.lastUpdateBlock >= program.endBlock) return program.rewardPerLiquidityAccumulator;

        // Determine the effective current block (capped at endBlock if past it)
        uint256 effectiveBlock = block.number < program.endBlock ? block.number : program.endBlock;
        uint256 blocksSinceUpdate = effectiveBlock - program.lastUpdateBlock;

        if (blocksSinceUpdate == 0) {
            return program.rewardPerLiquidityAccumulator;
        }

        // Use REGISTERED liquidity instead of total pool liquidity
        uint256 currentRegisteredLiq = program.totalRegisteredLiquidity;

        uint256 newAccumulator = program.rewardPerLiquidityAccumulator;

        if (currentRegisteredLiq > 0 && program.rewardPerBlock > 0) {
            uint256 rewardPerLiqPerBlock = (program.rewardPerBlock * PRECISION) / currentRegisteredLiq;
            newAccumulator += rewardPerLiqPerBlock * blocksSinceUpdate;
        }

        return newAccumulator;
    }

    /// @dev Internal: Transfer rewards (handles both ERC20 and native tokens)
    /// @param token Token address (address(0) for native)
    /// @param recipient Recipient address
    /// @param amount Amount to transfer
    function _transferReward(
        address token,
        address recipient,
        uint256 amount
    ) internal {
        if (token == address(0)) {
            payable(recipient).sendValue(amount);
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }
    }
}
