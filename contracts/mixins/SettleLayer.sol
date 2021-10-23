// SPDX-License-Identifier: Unlicensed                                                          
pragma solidity >=0.8.4;
pragma experimental ABIEncoderV2;

import '../libraries/Directives.sol';
import '../libraries/TransferHelper.sol';
import '../libraries/TokenFlow.sol';
import './StorageLayout.sol';
import './AgentMask.sol';

import "hardhat/console.sol";

contract SettleLayer is AgentMask {
    using SafeCast for uint256;
    using TokenFlow for address;

    function settleFinal (int128 flow, Directives.SettlementChannel memory dir,
                          int128 ethFlows) internal {
        (address debitor, address creditor) = agentsSettle();
        settleFinal(debitor, creditor, flow, dir, ethFlows);
    }

    function settleLeg (int128 flow, Directives.SettlementChannel memory dir)
        internal returns (int128 ethFlows) {
        (address debitor, address creditor) = agentsSettle();
        return settleLeg(debitor, creditor, flow, dir);
    }
    
    function settleFinal (address debitor, address creditor, int128 flow,
                          Directives.SettlementChannel memory dir,
                          int128 ethFlows) internal {
        ethFlows += settleLeg(debitor, creditor, flow, dir);
        transactEther(debitor, creditor, ethFlows, dir.useSurplus_);
    }

    function settleLeg (address debitor, address creditor, int128 flow,
                        Directives.SettlementChannel memory dir)
        internal returns (int128 ethFlows) {
        require(passesLimit(flow, dir.limitQty_), "K");
        if (moreThanDust(flow, dir.dustThresh_)) {
            ethFlows = pumpFlow(debitor, creditor, flow, dir.token_, dir.useSurplus_);
        }
    }

    function settleFlows (address base, address quote, int128 baseFlow, int128 quoteFlow,
                          bool useSurplus) internal {
        (address debitor, address creditor) = agentsSettle();
        transactFlow(debitor, creditor, baseFlow, base, useSurplus);
        transactFlow(debitor, creditor, quoteFlow, quote, useSurplus);
    }

    function settleInitFlow (address recv,
                             address base, int128 baseFlow,
                             address quote, int128 quoteFlow) internal {
        transactFlow(recv, recv, baseFlow, base, false);
        transactFlow(recv, recv, quoteFlow, quote, false);
    }
        
    function pumpFlow (address debitor, address creditor, int128 flow,
                       address token, bool useReserves)
        private returns (int128) {
        if (token.isEtherNative()) {
            return flow;
        } else {
            transactFlow(debitor, creditor, flow, token, useReserves);
            return 0;
        }
    }

    function querySurplus (address user, address token) internal view returns (uint128) {
        bytes32 key = encodeSurplusKey(user, token);
        return surplusCollateral_[key];
    }

    function depositSurplus (address owner, uint128 value, address token) internal {
        debitTransfer(owner, value, token);
        bytes32 key = encodeSurplusKey(owner, token);
        surplusCollateral_[key] += value;
    }
    
    function disburseSurplus (address owner, address recv,
                              uint128 value, address token) internal {
        bytes32 key = encodeSurplusKey(owner, token);
        uint128 balance = surplusCollateral_[key];

        if (value == 0) { value = balance; }
        require(balance > 0 && value < balance, "SC");

        creditTransfer(recv, value, token);
        surplusCollateral_[key] -= value;
    }

    function isDebit (int128 flow) private pure returns (bool) {
        return flow > 0;
    }
    function isCredit (int128 flow) private pure returns (bool) {
        return flow < 0;
    }

    function transactEther (address debitor, address creditor,
                            int128 flow, bool useReserves)
        private {
        if (flow != 0) {
            transactFlow(debitor, creditor, flow, address(0), useReserves);
        } else {
            refundEther(creditor);
        }
    }
    
    function transactFlow (address debitor, address creditor,
                           int128 flow, address token, bool useReserves)
        private {
        if (isDebit(flow)) {
            debitUser(debitor, uint128(flow), token, useReserves);
        } else if (isCredit(flow)) {
            creditUser(creditor, uint128(-flow), token, useReserves);            
        }           
    }
    
    function debitUser (address recv, uint128 value, address token,
                        bool useReserves) private {
        if (useReserves) {
            uint128 remainder = debitSurplus(recv, value, token);
            debitRemainder(recv, remainder, token);
        } else {
            debitTransfer(recv, value, token);
        }
    }

    function debitRemainder (address recv, uint128 remainder, address token) private {
        if (remainder > 0) {
            debitTransfer(recv, remainder, token);
        } else if (token.isEtherNative()) {
            refundEther(recv);
        }
    }

    function creditUser (address recv, uint128 value, address token,
                         bool useReserves) private {
        if (useReserves) {
            creditSurplus(recv, value, token);
            creditRemainder(recv, token);
        } else {
            creditTransfer(recv, value, token);
        }
    }

    function creditRemainder (address recv, address token) private {
        if (token.isEtherNative()) {
            refundEther(recv);
        }
    }

    function creditTransfer (address recv, uint128 value, address token) private {
        if (token.isEtherNative()) {
            payEther(recv, value);
        } else {
            TransferHelper.safeTransfer(token, recv, value);
        }
    }

    function debitTransfer (address recv, uint128 value, address token) private {
        if (token.isEtherNative()) {
            collectEther(recv, value);
        } else {
            collectToken(recv, value, token);
        }
    }

    function refundEther (address recv) private {
        collectEther(recv, 0);
    }

    function payEther (address recv, uint128 value) private {
        uint128 overpay = (msg.value).toUint128();
        TransferHelper.safeEtherSend(recv, value + overpay);
    }
    
    function collectEther (address recv, uint128 value) private {
        require(msg.value >= value, "EC");
        uint128 overpay = (msg.value).toUint128() - value;
        if (overpay > 0) {
            TransferHelper.safeEtherSend(recv, overpay);
        }    
    }

    function collectToken (address recv, uint128 value, address token) private {
        uint256 openBal = IERC20Minimal(token).balanceOf(address(this));
        TransferHelper.safeTransferFrom(token, recv, address(this), value);
        uint256 postBal = IERC20Minimal(token).balanceOf(address(this));
        require(postBal > openBal &&
                postBal - openBal >= value, "TD");
    }

    function creditSurplus (address recv, uint128 value, address token) private {
        bytes32 key = encodeSurplusKey(recv, token);
        surplusCollateral_[key] += value;
    }

    function debitSurplus (address recv, uint128 value, address token) private
        returns (uint128 remainder) {
        bytes32 key = encodeSurplusKey(recv, token);
        uint128 balance = surplusCollateral_[key];

        if (balance > value) {
            surplusCollateral_[key] -= value;
        } else {
            surplusCollateral_[key] = 0;
            remainder = value - balance;
        }
    }

    function passesLimit (int128 flow, int128 limitQty)
        private pure returns (bool) {
        return flow <= limitQty;
    }

    function passesMintLimit (int128 baseFlow, int128 quoteFlow, int128 limitQty)
        private pure returns (bool) {
        return limitQty < 0 ?
            baseFlow <= -limitQty :
            quoteFlow <= limitQty;
    }

    function passesBurnLimit (int128 baseFlow, int128 quoteFlow, int128 limitQty)
        private pure returns (bool) {
        return limitQty < 0 ?
            baseFlow <= limitQty :
            quoteFlow <= -limitQty;
    }

    function moreThanDust (int128 flow, uint128 dustThresh)
        private pure returns (bool) {
        if (isDebit(flow)) {
            return true;
        } else {
            return uint128(-flow) > dustThresh;
        }
    }

    function encodeSurplusKey (address owner, address token) internal
        pure returns (bytes32) {
        return keccak256(abi.encode(owner, token));
    }
}

