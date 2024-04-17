// SPDX-License-Identifier: GPL-3

pragma solidity 0.8.19;

import "../callpaths/ColdPath.sol";
import "../CrocEvents.sol";

/* @title Cold path upgrade test contract
 * @notice Used for testing the upgrade functionality via nativedex governance.
           Success would mean the ColdPath functions can be invoked on index 33 */
contract ColdPathUpgrade is ColdPath {
    using SafeCast for uint128;
    using TokenFlow for TokenFlow.PairSeq;
    using CurveMath for CurveMath.CurveState;
    using Chaining for Chaining.PairFlow;
    using ProtocolCmd for bytes;

    /* @notice Forces installation on index 33 */
    function acceptCrocProxyRole(
        address,
        uint16 slot
    ) public pure override returns (bool) {
        return slot == 33;
    }
}
