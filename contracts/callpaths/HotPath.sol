// SPDX-License-Identifier: Unlicensed

pragma solidity >=0.8.4;

import '../libraries/Directives.sol';
import '../libraries/Encoding.sol';
import '../libraries/TokenFlow.sol';
import '../libraries/PriceGrid.sol';
import '../mixins/MarketSequencer.sol';
import '../mixins/SettleLayer.sol';
import '../mixins/PoolRegistry.sol';
import '../mixins/MarketSequencer.sol';
import '../mixins/ProtocolAccount.sol';

/* @title Hot path mixin.
 * @notice Provides the top-level function for the most common operation: simple one-hop
 *         swap on a single pool in the most gas optimized way. Unlike the other call 
 *         paths this should be imported directly into the main contract.
 * 
 * @dev    Unlike the other callpath sidecars this contains the most gas sensitive and
 *         common operation: a simple swap. We want to keep this the lowest gas spend
 *         possible, and therefore avoid an external DELEGATECALL. Therefore this logic
 *         is inherited both directly by the main contract (allowing for low gas calls)
 *         as well as an explicit proxy contract (allowing for future upgradeability)
 *         which can be utilized through a different call path. */
contract HotPath is MarketSequencer, SettleLayer, PoolRegistry, ProtocolAccount {
    using SafeCast for uint128;
    using TokenFlow for TokenFlow.PairSeq;
    using CurveMath for CurveMath.CurveState;
    using Chaining for Chaining.PairFlow;

    
    function swapExecute (address base, address quote,
                          uint24 poolIdx, bool isBuy, bool inBaseQty, uint128 qty,
                          uint24 poolTip,
                          uint128 limitPrice, uint128 minOutput,
                          uint8 reserveFlags) internal
        returns (int128){
        
        PoolSpecs.PoolCursor memory pool = preparePoolCntx
            (base, quote, poolIdx, poolTip, isBuy, inBaseQty, qty);
        Chaining.PairFlow memory flow = swapDir(pool, isBuy, inBaseQty, qty, limitPrice);

        int128 outFlow = pivotOutFlow(flow, minOutput, isBuy, inBaseQty);        
        settleFlows(base, quote, flow.baseFlow_, flow.quoteFlow_, reserveFlags);
        accumProtocolFees(flow, base, quote);
        return outFlow;
    }

    function pivotOutFlow (Chaining.PairFlow memory flow, uint128 minOutput,
                           bool isBuy, bool inBaseQty) private pure
        returns (int128 outFlow) {
        outFlow = inBaseQty ? flow.quoteFlow_ : flow.baseFlow_;
        bool isOutPaid = (isBuy == inBaseQty);
        int128 thresh = isOutPaid ? -int128(minOutput) : int128(minOutput);
        require(outFlow <= thresh || minOutput == 0, "SL");
    }

    function swapDir (PoolSpecs.PoolCursor memory pool, bool isBuy,
                      bool inBaseQty, uint128 qty, uint128 limitPrice) private
        returns (Chaining.PairFlow memory) {
        Directives.SwapDirective memory dir;
        dir.isBuy_ = isBuy;
        dir.inBaseQty_ = inBaseQty;
        dir.qty_ = qty;
        dir.limitPrice_ = limitPrice;
        return swapOverPool(dir, pool);
        
    }
    
    function preparePoolCntx (address base, address quote,
                              uint24 poolIdx, uint24 poolTip,
                              bool isBuy, bool inBaseQty, uint128 qty) private
        returns (PoolSpecs.PoolCursor memory) {
        PoolSpecs.PoolCursor memory pool = queryPool(base, quote, poolIdx);
        if (poolTip > pool.head_.feeRate_) {
            pool.head_.feeRate_ = poolTip;
        }
        verifyPermitSwap(pool, base, quote, isBuy, inBaseQty, qty);
        return pool;
    }

    function swapEncoded (bytes calldata input) internal returns (int128 outFlow) {
        (address base, address quote,
         uint24 poolIdx, bool isBuy, bool inBaseQty, uint128 qty, uint24 poolTip,
         uint128 limitPrice, uint128 minOutput, uint8 reserveFlags) =
            abi.decode(input, (address, address, uint24, bool, bool,
                               uint128, uint24, uint128, uint128, uint8));
        
        return swapExecute(base, quote, poolIdx, isBuy, inBaseQty, qty, poolTip,
                           limitPrice, minOutput, reserveFlags);
    }
}

/* @title Hot path proxy contract
 * @notice The version of the HotPath in a standalone sidecar proxy contract. If used
 *         this contract would be attached to hotProxy_ in the main dex contract. */
contract HotProxy is HotPath {

    function userCmd (bytes calldata input) public payable {
        swapEncoded(input);
    }
}


