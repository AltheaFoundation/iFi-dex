// SPDX-License-Identifier: Unlicensed

pragma solidity >=0.8.4;
pragma experimental ABIEncoderV2;

import './LowGasSafeMath.sol';
import './SafeCast.sol';
import './FixedPoint.sol';
import './LiquidityMath.sol';
import './CompoundMath.sol';
import './CurveMath.sol';

import "hardhat/console.sol";

/* @title Curve roll library
 * @notice Provides functionality for rolling swap flows onto a constant-product
 *         AMM liquidity curve. */
library CurveRoll {
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;
    using SafeCast for uint256;
    using SafeCast for uint128;
    using LiquidityMath for uint128;
    using CompoundMath for uint256;
    using SafeCast for uint256;
    using CurveMath for CurveMath.CurveState;
    using CurveMath for CurveMath.SwapFrame;
    using CurveMath for uint128;

    /* @notice Applies a given swap flow onto a constant product AMM curve and adjusts
     *   the swap accumulators and curve price. The price target and flows are set
     *   at a point that guarantees incremental collateral safety. 
     *
     * @dev Note that this function does *NOT* check whether the curve is liquidity 
     *   stable through the swap impact. It's the callers job to make sure that the 
     *   impact doesn't cross through any tick barrier that knocks concentrated liquidity
     *   in/out. 
     *
     * @param curve - The current state of the active liquidity curve. After calling
     *   this struct will be updated with the post-swap price. Note that none of the
     *   fee accumulator fields are adjusted. This function does *not* collect or apply
     *   liquidity fees. It's the callers responsibility to handle fees outside this
     *   call.
     * @param flow - The amount of tokens to swap on this leg. Denominated in quote or
     *   base tokens based on the swap object context. In certain cases this number
     *   may be a fixed point estimate based on a price target. Collateral safety
     *   is guaranteed with up to 2 wei of precision loss.
     * @param swap - The in-progress swap object. The accumulator fields will be 
     *   incremented based on the swapped flow and its relevant impact. */
    function rollFlow (CurveMath.CurveState memory curve, uint128 flow,
                       CurveMath.SwapAccum memory swap) internal pure {        
        (uint128 counterFlow, uint128 nextPrice) = deriveImpact(curve, flow, swap.cntx_);
        (int128 paidFlow, int128 paidCounter) = signFlow(flow, counterFlow, swap.cntx_);
        setCurvePos(curve, swap, nextPrice, paidFlow, paidCounter);
    }

    /* @notice Moves a curve to a pre-determined price target, and adjusts the swap flows
     *   as necessary to reach the target. The final curve will end at exactly that price
     *   and the flows are set to guarantee incremental collateral safety.
     *
     * @dev Note that this function does *NOT* check whether the curve is liquidity 
     *   stable through the swap impact. It's the callers job to make sure that the 
     *   impact doesn't cross through any tick barrier that knocks concentrated liquidity
     *   in/out. 
     *
     * @param curve - The current state of the active liquidity curve. After calling
     *   this struct will be updated with the post-swap price. Note that none of the
     *   fee accumulator fields are adjusted. This function does *not* collect or apply
     *   liquidity fees. It's the callers responsibility to handle fees outside this
     *   call.
     * @param price - Price target that the curve will be re-pegged at.
     * @param swap - The in-progress swap object. The accumulator fields will be 
     *   incremented based on the swapped flow and its relevant impact. */
    function rollPrice (CurveMath.CurveState memory curve, uint128 price,
                        CurveMath.SwapAccum memory swap) internal pure {
        (uint128 flow, uint128 counterFlow) = deriveDemand(curve, price, swap);
        (int128 paidFlow, int128 paidCounter) = signFixed(flow, counterFlow, swap.cntx_);
        setCurvePos(curve, swap, price, paidFlow, paidCounter);
    }

    /* @notice Called when a curve has reached its lower bump barrier. Because the 
     *   barrier occurs at the first price in the tick, we need to "shave the price"
     *   down into the next tick. The curve has kicked in liquidity that's only active
     *   below this price, and we need the price to reflect the correct tick. So we burn
     *   an economically meaningless amount of quote token wei to bring the price down
     *   by exactly one unit of precision into the next tick. */
    function shaveAtBump (CurveMath.CurveState memory curve,
                          CurveMath.SwapAccum memory accum) pure internal {
        uint128 burnDown = CurveMath.priceToTokenPrecision
            (curve.activeLiquidity(), curve.priceRoot_, accum.cntx_.isBuy_);
        if (accum.cntx_.isBuy_) {
            setShaveUp(curve, accum, burnDown);
        } else {
            setShaveDown(curve, accum, burnDown);
        }
    }

    function setShaveDown (CurveMath.CurveState memory curve, 
                           CurveMath.SwapAccum memory swap,
                           uint128 burnDown) private pure {
        if (!swap.cntx_.inBaseQty_) {
            require(swap.qtyLeft_ > burnDown, "BD");
            swap.qtyLeft_ = swap.qtyLeft_ - burnDown;
        }
        swap.paidQuote_ += burnDown.toInt128Sign();
        if (curve.priceRoot_ > TickMath.MIN_SQRT_RATIO) {
            curve.priceRoot_ -= 1;
        }
    }

    function setShaveUp (CurveMath.CurveState memory curve, 
                           CurveMath.SwapAccum memory swap,
                           uint128 burnDown) private pure {
        if (swap.cntx_.inBaseQty_) {
            require(swap.qtyLeft_ > burnDown, "BD");
            swap.qtyLeft_ -= burnDown;
        }
        swap.paidBase_ += burnDown.toInt128Sign();
        if (curve.priceRoot_ < TickMath.MAX_SQRT_RATIO - 1) {
            curve.priceRoot_ += 1;
        }
    }

    function setCurvePos (CurveMath.CurveState memory curve, 
                          CurveMath.SwapAccum memory swap, uint128 price,
                          int128 paidFlow, int128 paidCounter) private pure {
        uint128 spent = flowToSpent(paidFlow, swap.cntx_.inBaseQty_, swap.cntx_.isBuy_);
        
        if (spent >= swap.qtyLeft_) {
            swap.qtyLeft_ = 0;
        } else {
            swap.qtyLeft_ -= spent;
        }

        swap.paidBase_ += (swap.cntx_.inBaseQty_ ? paidFlow : paidCounter);
        swap.paidQuote_ += (swap.cntx_.inBaseQty_ ? paidCounter : paidFlow); 
        curve.priceRoot_ = price;
    }

    /* @notice Convert a signed paid flow to a decrement to apply to swap qty left. */
    function flowToSpent (int128 paidFlow, bool inBaseQty, bool isBuy)
        private pure returns (uint128) {
        int128 spent = (inBaseQty == isBuy) ? paidFlow : -paidFlow;
        if (spent < 0) { return 0; }
        return uint128(spent);
    }

    /* @notice Calculates the flow and counterflow associated with moving the constant
     *         product curve to a target price.
     * @dev    Both sides of the flow are rounded down at up to 2 wei of precision loss
     *         (see CurveMath.sol). The results should not be used directly without 
     *         buffering the counterflow in the direction of collateral support. */
    function deriveDemand (CurveMath.CurveState memory curve, uint128 price,
                           CurveMath.SwapAccum memory swap) private pure
        returns (uint128 flow, uint128 counterFlow) {
        uint128 liq = curve.activeLiquidity();
        uint128 baseFlow = liq.deltaBase(curve.priceRoot_, price);
        uint128 quoteFlow = liq.deltaQuote(curve.priceRoot_, price);
        if (swap.cntx_.inBaseQty_) {
            (flow, counterFlow) = (baseFlow, quoteFlow);
        } else {
            (flow, counterFlow) = (quoteFlow, baseFlow);
            
        }
    }

    /* @notice Given a fixed swap flow on a cosntant product AMM curve, calculates
     *   the final price and counterflow. This function assumes that the AMM curve is
     *   constant product stable through the impact range. It's the caller's 
     *   responsibility to check that we're not passing liquidity bump tick boundaries.
     *
     * @dev The price and counter-flow guarantee collateral stability on the AMM curve.
     *   Because of fixed-point effects the price may be arbitarily rounded, but the 
     *   counter-flow will always be set correctly to match. The result of this function
     *   is based on the AMM curve being constant through the entire range. Note that 
     *   this function only calulcates a result it does *not* write into the Curve or 
     *   Swap structs.
     *
     * @param curve The constant-product AMM curve
     * @param flow  The fixed token flow from the side the swap is denominated in.
     * @param cntx  The context of the executiing swap
     *
     * @return counterFlow The magnitude of token flow on the opposite side the swap
     *                     is denominated in. Note that this value is *not* signed. Also
     *                     note that this value is always rounded down. 
     * @return nextPrice   The ending price of the curve assumign the full flow is 
     *                     processed. Note that this value is *not* written into the 
     *                     curve struct. */
    function deriveImpact (CurveMath.CurveState memory curve, uint128 flow,
                           CurveMath.SwapFrame memory cntx) internal pure
        returns (uint128 counterFlow, uint128 nextPrice) {
        uint128 liq = curve.activeLiquidity();
        nextPrice = deriveFlowPrice(curve.priceRoot_, liq, flow, cntx);

        /* We calculate the counterflow exactly off the computed price. Ultimately safe
         * collateralization only cares about the price, not the contravening flow.
         * Therefore we always compute based on the final, rounded price, not from the
         * original fixed flow. */
        counterFlow = !cntx.inBaseQty_ ?
            liq.deltaBase(curve.priceRoot_, nextPrice) :
            liq.deltaQuote(curve.priceRoot_, nextPrice);
    }

    /* @dev The end price is always rounded to the inside of the flow token:
     *
     *       Flow   |   Dir   |  Price Roudning  | Loss of Precision
     *     ---------------------------------------------------------------
     *       Base   |   Buy   |     Down         |    1 wei
     *       Base   |   Sell  |     Down         |    1 wei
     *       Quote  |   Buy   |     Up           |   Arbitrary
     *       Quote  |   Buy   |     Up           |   Arbitrary
     * 
     *   This guarantees that the pool is adaquately collateralized given the flow of the
     *   fixed side. Because of the arbitrary roudning, it's critical that the counter-
     *   flow is computed using the exact price returned by this function, and not 
     *   independently. */
    function deriveFlowPrice (uint128 price, uint128 liq,
                              uint128 flow, CurveMath.SwapFrame memory cntx)
        private pure returns (uint128) {
        uint128 curvePrice = cntx.inBaseQty_ ?
            calcBaseFlowPrice(price, liq, flow, cntx.isBuy_) :
            calcQuoteFlowPrice(price, liq, flow, cntx.isBuy_);

        if (curvePrice >= TickMath.MAX_SQRT_RATIO) { return TickMath.MAX_SQRT_RATIO - 1;}
        if (curvePrice < TickMath.MIN_SQRT_RATIO) { return TickMath.MIN_SQRT_RATIO; }
        return curvePrice;
    }

    /* Because the base flow is fixed, we want to always set the price to in favor of 
     * base token over-collateralization. Upstream, we'll independently set quote token
     * flows based off the price calculated here. Since higher price increases base 
     * collateral, we round price down regardless of whether the fixed base flow is a 
     * buy or a sell. 
     *
     * This seems counterintuitive when base token is the output, but even then moving 
     * the price further down will increase the quote token input and over-collateralize
     * the base token. The max loss of precision is 1 unit of fixed-point price. */
    function calcBaseFlowPrice (uint128 price, uint128 liq, uint128 flow, bool isBuy)
        private pure returns (uint128) {
        if (liq == 0) { return type(uint128).max; }
        
        uint192 deltaCalc = FixedPoint.divQ64(flow, liq);
        if (deltaCalc > type(uint128).max) { return type(uint128).max; }
        uint128 priceDelta = uint128(deltaCalc);
        
        if (isBuy) {
            return price + priceDelta;
        } else {
            if (priceDelta >= price) { return 0; }
            return price - (priceDelta + 1);
        }
    }

    /* The same rounding logic as calcBaseFlowPrice applies, but because it's the 
     * opposite side we want to conservatively round the price *up*, regardless of 
     * whether it's a buy or sell. 
     * 
     * Calculating flow price for quote flow is more complex because the flow delta 
     * applies to the inverse of the price. So when calculating the inverse, we make 
     * sure to round in the direction that founds up the final price.
     *
     * Because the calculation involves multiple nested divisors there's an arbitrary 
     * loss of precision due to rounding. However this is almost always small unless
     * liquidity is very small, flow is very large or price is very extreme. */
    function calcQuoteFlowPrice (uint128 price, uint128 liq, uint128 flow, bool isBuy)
        private pure returns (uint128) {
        // Since this is a term in the quotient rounding down, rounds up the final price
        uint128 invPrice = FixedPoint.recipQ64(price);
        // This is also a quotient term so we use this function's round down logic
        uint128 invNext = calcBaseFlowPrice(invPrice, liq, flow, !isBuy);
        if (invNext == 0) { return TickMath.MAX_SQRT_RATIO; }
        return FixedPoint.recipQ64(invNext) + 1;
    }


    // Max round precision loss is 2 wei, but a 4 wei cushion provides extra margin
    // and is economically meaningless.
    int128 constant ROUND_PRECISION_WEI = 4;

    /* @notice Correctly assigns the signed direction to the unsigned flow and counter
     *   flow magnitudes that were previously computed for a fixed flow swap. Positive 
     *   sign implies the flow is being received by the pool, negative that it's being 
     *   received by the user. */
    function signFlow (uint128 flowMagn, uint128 counterMagn,
                       CurveMath.SwapFrame memory cntx)
        private pure returns (int128 flow, int128 counter) {
        (flow, counter) = signMagn(flowMagn, counterMagn, cntx);
        // Conservatively round directional counterflow in the direction of the pool's
        // collateral. Don't round swap flow because that's a fixed target. 
        counter = counter + ROUND_PRECISION_WEI;
    }

    /* @notice Same as signFixed, but used for the flow from a price target swap leg. */
    function signFixed (uint128 flowMagn, uint128 counterMagn,
                        CurveMath.SwapFrame memory cntx)
        private pure returns (int128 flow, int128 counter) {
        (flow, counter) = signMagn(flowMagn, counterMagn, cntx);
        // In a price target, bothsides of the flow are floating, and have to be rounded
        // in pool's favor to conservatively accomodate the price precision.
        flow = flow + ROUND_PRECISION_WEI;
        counter = counter + ROUND_PRECISION_WEI;
    }
    
    function signMagn (uint128 flowMagn, uint128 counterMagn,
                       CurveMath.SwapFrame memory cntx)
        private pure returns (int128 flow, int128 counter) {
        
        if (cntx.inBaseQty_ == cntx.isBuy_) {
            (flow, counter) = (flowMagn.toInt128Sign(), -counterMagn.toInt128Sign());
        } else {
            (flow, counter) = (-flowMagn.toInt128Sign(), counterMagn.toInt128Sign());
        }
        
        
    }
}
