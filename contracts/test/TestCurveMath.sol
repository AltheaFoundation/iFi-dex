// SPDX-License-Identifier: Unlicensed
pragma solidity >=0.7.0;

import "../libraries/FullMath.sol";
import "../libraries/CurveMath.sol";
import "../libraries/CurveAssimilate.sol";
import "../libraries/CurveRoll.sol";
import "../libraries/SwapCurve.sol";

import "hardhat/console.sol";

contract TestCurveMath {
    using CurveMath for CurveMath.SwapFrame;
    
    function testActiveLiq (uint128 seed, uint64 growth, uint128 concentrated)
        public pure returns (uint128) {
        return CurveMath.activeLiquidity(
            buildCurve(seed, growth, concentrated, 0));
    }

    function testVig (uint128 liq, uint128 swapQty, uint24 feeRate, uint8 protoCut,
                      bool isBuy, bool inBase, uint128 curvePrice, uint128 limitPrice)
        public pure returns (uint128, uint128) {
        CurveMath.CurveState memory curve = buildCurve(liq, 0, 0, curvePrice);
        CurveMath.SwapFrame memory cntx = CurveMath.SwapFrame(isBuy, inBase, feeRate, protoCut);
        CurveMath.SwapAccum memory swap = CurveMath.SwapAccum(swapQty, 0, 0, 0, cntx);
        return SwapCurve.vigOverFlow(curve, swap, limitPrice);
    }

    function testVigMin (uint128 liq, uint24 feeRate, uint8 protoCut,
                         bool inBase, uint128 curvePrice)
        public pure returns (uint128, uint128) {
        uint128 swapQty = type(uint128).max;
        bool isBuy = inBase ? false : true;
        return testVig(liq, swapQty, feeRate, protoCut, isBuy, inBase, curvePrice,
                       TickMath.MIN_SQRT_RATIO);
    }

    function testVigMax (uint128 liq, uint24 feeRate, uint8 protoCut,
                         bool inBase, uint128 curvePrice)
        public pure returns (uint128, uint128) {
        uint128 swapQty = type(uint128).max;
        bool isBuy = inBase ? true : false;
        return testVig(liq, swapQty, feeRate, protoCut, isBuy, inBase, curvePrice,
                       TickMath.MAX_SQRT_RATIO);
    }

    function testLimitBase (uint128 price, uint128 limitPrice, uint128 liq)
        public pure returns (uint128) {
        CurveMath.CurveState memory curve = buildCurve(liq, 0, 0, price);
        return CurveMath.calcLimitFlows(curve, 1000000, true, limitPrice);
    }

    function testLimitQuote (uint128 price, uint128 limitPrice, uint128 liq)
        public pure returns (uint128) {
        CurveMath.CurveState memory curve = buildCurve(liq, 0, 0, price);
        return CurveMath.calcLimitFlows(curve, 1000000, false, limitPrice);
    }

    function testCounterBase (uint128 price, uint128 limitPrice, uint128 liq)
        public pure returns (uint128) {
        CurveMath.CurveState memory curve = buildCurve(liq, 0, 0, price);
        return CurveMath.calcLimitCounter(curve, 1000000, true, limitPrice);
    }

    function testCounterQuote (uint128 price, uint128 limitPrice, uint128 liq)
        public pure returns (uint128) {
        CurveMath.CurveState memory curve = buildCurve(liq, 0, 0, price);
        return CurveMath.calcLimitCounter(curve, 1000000, false, limitPrice);
    }

    function testLimitBaseMax (uint128 price, uint128 liq)
        public pure returns (uint128) {
        return testLimitBase(price, TickMath.MAX_SQRT_RATIO, liq);
    }    

    function testLimitBaseMin (uint128 price, uint128 liq)
        public pure returns (uint128) {
        return testLimitBase(price, TickMath.MIN_SQRT_RATIO, liq);
    }    

    function testLimitQuoteMax (uint128 price, uint128 liq)
        public pure returns (uint128) {
        return testLimitQuote(price, TickMath.MAX_SQRT_RATIO, liq);
    }    

    function testLimitQuoteMin (uint128 price, uint128 liq)
        public pure returns (uint128) {
        return testLimitQuote(price, TickMath.MIN_SQRT_RATIO, liq);
    }    

    function testCounterBaseMax (uint128 price, uint128 liq)
        public pure returns (uint128) {
        return testCounterBase(price, TickMath.MAX_SQRT_RATIO, liq);
    }    

    function testCounterBaseMin (uint128 price, uint128 liq)
        public pure returns (uint128) {
        return testCounterBase(price, TickMath.MIN_SQRT_RATIO, liq);
    }    

    function testCounterQuoteMax (uint128 price, uint128 liq)
        public pure returns (uint128) {
        return testCounterQuote(price, TickMath.MAX_SQRT_RATIO, liq);
    }    

    function testCounterQuoteMin (uint128 price, uint128 liq)
        public pure returns (uint128) {
        return testCounterQuote(price, TickMath.MIN_SQRT_RATIO, liq);
    }    

    function testLimitQtyLeft (uint128 price, uint128 limitPrice, uint128 liq,
                               uint128 swapQty)
        public pure returns (uint128) {
        CurveMath.CurveState memory curve = buildCurve(liq, 0, 0, price);
        return CurveMath.calcLimitFlows(curve, swapQty, true, limitPrice);
    }

    function testCounterQtyLeft (uint128 price, uint128 limitPrice, uint128 liq,
                                 uint128 swapQty)
        public pure returns (uint128) {
        CurveMath.CurveState memory curve = buildCurve(liq, 0, 0, price);
        return CurveMath.calcLimitCounter(curve, swapQty, true, limitPrice);
    }

    function testRoll (uint128 flow, uint128 price, uint128 liq,
                       bool isBuy, bool inBase)
        public pure returns (uint128 rollPrice, uint128 qtyLeft,
                             int128 paidBase, int128 paidQuote) {
        CurveMath.SwapAccum memory swap = buildSwap(flow, isBuy, inBase);
        CurveMath.CurveState memory curve = buildCurve(liq, 0, 0, price);
        CurveRoll.rollFlow(curve, flow, swap);
        (rollPrice, qtyLeft, paidBase, paidQuote) =
            (curve.priceRoot_, swap.qtyLeft_, swap.paidBase_, swap.paidQuote_);
    }

    function testRollInf (uint128 liq, uint128 price, bool isBuy, bool inBase)
        public pure returns (uint128 rollPrice, uint128 qtyLeft,
                             int128 paidBase, int128 paidQuote) {
        uint128 flow = (isBuy == inBase) ? uint128(type(int128).max) :
            SafeCast.toUint128(inBase ?
                    FullMath.mulDiv(liq, price, FixedPoint.Q96) :
                    FullMath.mulDiv(liq, FixedPoint.Q96, price));
        (rollPrice, qtyLeft, paidBase, paidQuote) =
            testRoll(flow, price, liq, isBuy, inBase);
    }

    function testAssimilate (uint128 feesPaid, uint128 price,
                             uint128 seed, uint128 conc, uint64 growth, bool inBase)
        public pure returns (uint128 shiftPrice, uint128 shiftSeed,
                             uint128 shiftGrowth, uint128 concGrowth) {
        CurveMath.CurveState memory curve = buildCurve(seed, growth, conc, price);
        CurveAssimilate.assimilateLiq(curve, feesPaid, inBase);
        
        (shiftPrice, shiftSeed) = (curve.priceRoot_, curve.liq_.ambientSeed_);
        (shiftGrowth, concGrowth) = (curve.accum_.ambientGrowth_,
                                     curve.accum_.concTokenGrowth_);
    }

    function testDeriveImpact (uint128 price, uint128 seed, uint64 growth,
                               uint128 conc, uint128 flow, 
                               bool isBuy, bool inBase)
        public pure returns (uint128, uint128) {
        CurveMath.CurveState memory curve = buildCurve(seed, growth, conc, price);
        CurveMath.SwapAccum memory swap = buildSwap(flow, isBuy, inBase);
        return CurveRoll.deriveImpact(curve, flow, swap.cntx_);
    }
    
    function buildSwapFrame (bool isBuy, bool inBase)
        private pure returns (CurveMath.SwapFrame memory) {
        CurveMath.SwapFrame memory cntx = CurveMath.SwapFrame
            (isBuy, inBase, 0, 0);            
        return cntx;
    }

    function buildSwap (uint128 flow, bool isBuy, bool inBase)
        private pure returns (CurveMath.SwapAccum memory) {
        CurveMath.SwapFrame memory cntx = buildSwapFrame(isBuy, inBase);
        return CurveMath.SwapAccum(flow, 0, 0, 0, cntx);
    }
    
    function buildCurve (uint128 seed, uint64 growth, uint128 conc, uint128 price)
        private pure returns (CurveMath.CurveState memory) {
        CurveMath.CurveLiquidity memory liq = CurveMath.CurveLiquidity(seed, conc);
        CurveMath.CurveFeeAccum memory fee = CurveMath.CurveFeeAccum(growth, 0);
        return CurveMath.CurveState(price, liq, fee);        
    }
}
