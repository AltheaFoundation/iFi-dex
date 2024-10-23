// SPDX-License-Identifier: GPL-3

pragma solidity 0.8.19;

library CrocEvents {

    /* @notice Emitted whenever a swap is performed, exchanging buy tokens for sell tokens.
     * @param user The address of the user performing the swap.
     * @param buy The address of the token being bought.
     * @param sell The address of the token being sold.
     * @param poolIdx The template of the relevant pool.
     * @param buyFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param sellFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     */
    event Swap(address indexed user, address indexed buy, address indexed sell, uint256 poolIdx, int128 buyFlow, int128 sellFlow);

    /* @notice Emitted when a concentrated liquidity position is created, or additional liquidity is added to an existing position.
     * @param user The address of the user performing the mint.
     * @param base The address of the base token involved.
     * @param quote The address of the quote token involved.
     * @param poolIdx The template of the relevant pool.
     * @param liq The amount of liquidity (in sqrt(X*Y) terms) being added to the pool.
     * @param bidTick The lower price tick of the range position.
     * @param askTick The upper price tick of the range position.
     * @param baseFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param quoteFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     */
    event MintRanged(address indexed user, address indexed base, address indexed quote, uint256 poolIdx, uint128 liq, int24 bidTick, int24 askTick, int128 baseFlow, int128 quoteFlow);

    /* @notice Emitted when a concentrated liquidity position is burned, removing the liquidity from the pool.
     * @param user The address of the user performing the burn.
     * @param base The address of the base token involved.
     * @param quote The address of the quote token involved.
     * @param poolIdx The template of the relevant pool.
     * @param liq The amount of liquidity (in sqrt(X*Y) terms) being removed from the pool.
     * @param bidTick The lower price tick of the range position.
     * @param askTick The upper price tick of the range position.
     * @param baseFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param quoteFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     */
    event BurnRanged(address indexed user, address indexed base, address indexed quote, uint256 poolIdx, uint128 liq, int24 bidTick, int24 askTick, int128 baseFlow, int128 quoteFlow);

    /* @notice Emitted when a concentrated position's ambient rewards are harvested, removing ambient liquidity from the pool.
     * @param user The address of the user performing the harvest.
     * @param base The address of the base token involved.
     * @param quote The address of the quote token involved.
     * @param poolIdx The template of the relevant pool.
     * @param bidTick The lower price tick of the range position.
     * @param askTick The upper price tick of the range position.
     * @param baseFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param quoteFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     */
    event Harvest(address indexed user, address indexed base, address indexed quote, uint256 poolIdx, int24 bidTick, int24 askTick, int128 baseFlow, int128 quoteFlow);

    /* @notice Emitted when an ambient (full range) liquidity position is created, or additional liquidity is added to an existing position.
     * @param user The address of the user performing the mint.
     * @param base The address of the base token involved.
     * @param quote The address of the quote token involved.
     * @param poolIdx The template of the relevant pool.
     * @param liq The amount of liquidity (in sqrt(X*Y) terms) being added to the pool.
     * @param baseFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param quoteFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     */
    event MintAmbient(address indexed user, address indexed base, address indexed quote, uint256 poolIdx, uint128 liq, int128 baseFlow, int128 quoteFlow);

    /* @notice Emitted when an ambient (full range) liquidity position is burned, removing the liquidity from the pool.
     * @param user The address of the user performing the mint.
     * @param base The address of the base token involved.
     * @param quote The address of the quote token involved.
     * @param poolIdx The template of the relevant pool.
     * @param liq The amount of liquidity (in sqrt(X*Y) terms) being removed from the pool.
     * @param baseFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param quoteFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     */
    event BurnAmbient(address indexed user, address indexed base, address indexed quote, uint256 poolIdx, uint128 liq, int128 baseFlow, int128 quoteFlow);

    /* @notice Emitted when a knockout liquidity position is minted, adding one-way liquidity to the pool.
     * @param user The address of the position holder.
     * @param base The address of the base token involved.
     * @param quote The address of the quote token involved.
     * @param poolIdx The template of the relevant pool.
     * @param qty The amount of base (quote) tokens being added to the pool if isBid is (not) true
     * @param lowerTick The lower price tick of the range position.
     * @param upperTick The upper price tick of the range position.
     */
    event MintKnockout(address indexed user, address indexed base, address indexed quote, uint256 poolIdx, uint128 qty, bool isBid, int24 lowerTick, int24 upperTick);

    /* @notice Emitted when a knockout liquidity position is burned, removing an in-progress knockout position from the pool.
     * @param user The address of the position holder.
     * @param base The address of the base token involved.
     * @param quote The address of the quote token involved.
     * @param poolIdx The template of the relevant pool.
     * @param baseFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param quoteFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param lowerTick The lower price tick of the range position.
     * @param upperTick The upper price tick of the range position.
     */
    event BurnKnockout(address indexed user, address indexed base, address indexed quote, uint256 poolIdx, int128 baseFlow, int128 quoteFlow, int24 lowerTick, int24 upperTick);

    /* @notice Emitted when a complete knockout liquidity position is claimed or recovered, deleting the position from the pool.
     * @param user The address of the position holder.
     * @param base The address of the base token involved.
     * @param quote The address of the quote token involved.
     * @param poolIdx The template of the relevant pool.
     * @param baseFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param quoteFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param lowerTick The lower price tick of the range position.
     * @param upperTick The upper price tick of the range position.
     * @param proven Indicates a correct proof was provided and earned fees were collected.
     */
    event WithdrawKnockout(address indexed user, address indexed base, address indexed quote, uint256 poolIdx, int128 baseFlow, int128 quoteFlow, int24 lowerTick, int24 upperTick, bool proven);

    /* @notice Emitted when governance authority for CrocSwapDex is transfered.
     * @param The authority being transfered to. */
    event AuthorityTransfer (address indexed authority);

    /* @notice Indicates a new pool liquidity initialization value is set.
     * @param liq The pool initialization value. */
    event SetNewPoolLiq (uint128 liq);

    /* @notice Emitted when a new protocol take rate is set.
     * @param takeRate The take rate represents in units of 1/256. */     
    event SetTakeRate (uint8 takeRate);

    /* @notice Emitted when a new protocol relayer take rate is set.
     * @param takeRate The relayer take rate represents in units of 1/256. */
    event SetRelayerTakeRate (uint8 takeRate);

    /* @notice Emitted when a new template is disabled, halting new creation of that pool type.
     * @param poolIdx The pool type index being disabled. */
    event DisablePoolTemplate (uint256 indexed poolIdx);

    /* @notice Emitted when a new template is written or overwrriten.
     * @param poolIdx The pool type index being disabled.
     * @param feeRate The swap fee rate for the pool (represented in units of 0.0001%)
     * @param tickSize The minimum tick size for range orders in the pool.
     * @param jitThresh The JIT liquiidty TTL time in the pool (represented in 10s of seconds)
     * @param knockout The knockout liquidity paramter bits (see KnockoutLiq library for more detail)
     * @param oracleFlags The permissioned pool oracle flags if this is setup as a permissioned pool. */
    event SetPoolTemplate (uint256 indexed poolIdx, uint16 feeRate, uint16 tickSize,
                           uint8 jitThresh, uint8 knockout, uint8 oracleFlags);

    /* @notice Emitted when a new pool has been created for a given base and quote token pair using a template index of poolIdx.
     * @param base The base token of the pool.
     * @param quote The quote token of the pool.
     * @param poolIdx The pool's template.
     * @param price The initial price of the pool. Represented as square root price in Q64.64 notation.
     * @param user The address of the user creating the pool.
     * @param liq The initial liquidity of the pool.
     * @param baseFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it
     * @param quoteFlow A positive value indicates tokens flowing into the pool, negative indicates tokens flowing out of it */
    event InitPool(address indexed base, address indexed quote, uint256 indexed poolIdx, uint128 price, address user, uint128 liq, int128 baseFlow, int128 quoteFlow);

    /* @notice Emitted when a previously created pool with a pre-existing protocol take rate is re-
     *         sychronized to the current dex-wide protocol take rate setting. 
     * @param base The base token of the pool.
     * @param quote The quote token of the pool.
     * @param poolIdx The pool type index of the pool.
     * @param takeRate The newly set protocol take rate of the pool. */
    event ResyncTakeRate (address indexed base, address indexed quote,
                          uint256 indexed poolIdx, uint8 takeRate);

    /* @notice Emitted when new minimum thresholds are set for off-grid price improvement liquidity
     *         thresholds.
     * @param token The token the thresholds apply to.
     * @param unitTickCollateral The size of commited collateral required to mint positions off-grid
     * @param awayTickTol The maximum distance away an off-grid range can be minted from the current
     *                    price tick. */
    event PriceImproveThresh (address indexed token, uint128 unitTickCollateral,
                              uint16 awayTickTol);
    
    /* @notice Emitted when protocol governance sets a new teasury vault address
     * @param treasury The address the treasury vault is set to
     * @param startTime The earliest time that the vault will be eligible to collect protocol fees. */
    event TreasurySet (address indexed treasury, uint64 indexed startTime);

    /* @notice Emitted when accumulated protocol fees are collected by the treasury.
     * @param token The token of the fees being collected.
     * @param recv The vault the collected fees are being paid to. */
    event ProtocolDividend (address indexed token, address indexed recv);

    /* @notice Called when any proxy sidecar contract is upgraded.
     * @param proxy The address of the new proxy smart contract.
     * @param proxyIdx The proxy sidecar index slot the upgrade is applied to. */
    event UpgradeProxy (address indexed proxy, uint16 proxyIdx);

    /* @notice Called whenever the hot path open is toggled.
     * @param If true indicates the hot-path is open and users can directly call the swap() function
     *        If false, the hot path is closed and users must call the proxy contract to swap. */
    event HotPathOpen (bool);

    /* @notice Called whenever emergency safe mode is toggled
     * @param If true indicates emergency safe mode is turned on
     *        If false indicates emergency safe mode is turned off */
    event SafeMode (bool);
}
