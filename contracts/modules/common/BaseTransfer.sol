// Copyright (C) 2018  Argent Labs Ltd. <https://argent.xyz>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.6.10;

import "./BaseModule.sol";

/**
 * @title BaseTransfer
 * @dev Module containing internal methods to execute or approve transfers
 * @author Olivier VDB - <olivier@argent.xyz>
 */
abstract contract BaseTransfer is BaseModule {

    // Mock token address for ETH
    address constant internal ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // *************** Events *************************** //

    event Transfer(address indexed wallet, address indexed token, uint256 indexed amount, address to, bytes data);
    event Approved(address indexed wallet, address indexed token, uint256 amount, address spender);
    event CalledContract(address indexed wallet, address indexed to, uint256 amount, bytes data);
    event ApprovedAndCalledContract(
        address indexed wallet,
        address indexed to,
        address spender,
        address indexed token,
        uint256 amountApproved,
        uint256 amountSpent,
        bytes data
    );
    // *************** Internal Functions ********************* //

    /**
    * @dev Helper method to transfer ETH or ERC20 for a wallet.
    * @param _wallet The target wallet.
    * @param _token The ERC20 address.
    * @param _to The recipient.
    * @param _value The amount of ETH to transfer
    * @param _data The data to *log* with the transfer.
    */
    function doTransfer(address _wallet, address _token, address _to, uint256 _value, bytes memory _data) internal {
        if (_token == ETH_TOKEN) {
            invokeWallet(_wallet, _to, _value, EMPTY_BYTES);
        } else {
            bytes memory methodData = abi.encodeWithSignature("transfer(address,uint256)", _to, _value);
            invokeWallet(_wallet, _token, 0, methodData);
        }
        emit Transfer(_wallet, _token, _value, _to, _data);
    }

    /**
    * @dev Helper method to approve spending the ERC20 of a wallet.
    * @param _wallet The target wallet.
    * @param _token The ERC20 address.
    * @param _spender The spender address.
    * @param _value The amount of token to transfer.
    */
    function doApproveToken(address _wallet, address _token, address _spender, uint256 _value) internal {
        bytes memory methodData = abi.encodeWithSignature("approve(address,uint256)", _spender, _value);
        invokeWallet(_wallet, _token, 0, methodData);
        emit Approved(_wallet, _token, _value, _spender);
    }

    /**
    * @dev Helper method to call an external contract.
    * @param _wallet The target wallet.
    * @param _contract The contract address.
    * @param _value The ETH value to transfer.
    * @param _data The method data.
    */
    function doCallContract(address _wallet, address _contract, uint256 _value, bytes memory _data) internal {
        invokeWallet(_wallet, _contract, _value, _data);
        emit CalledContract(_wallet, _contract, _value, _data);
    }

    /**
    * @dev Helper method to approve a certain amount of token and call an external contract.
    * The address that spends the _token and the address that is called with _data can be different.
    * @param _wallet The target wallet.
    * @param _token The ERC20 address.
    * @param _spender The spender address.
    * @param _amount The amount of tokens to transfer.
    * @param _contract The contract address.
    * @param _data The method data.
    */
    function doApproveTokenAndCallContract(
        address _wallet,
        address _token,
        address _spender,
        uint256 _amount,
        address _contract,
        bytes memory _data
    )
        internal
    {
        uint256 existingAllowance = ERC20(_token).allowance(_wallet, _spender);
        uint256 totalAllowance = SafeMath.add(existingAllowance, _amount);
        // Approve the desired amount plus existing amount. This logic allows for potential gas saving later
        // when restoring the original approved amount, in cases where the _spender uses the exact approved _amount.
        bytes memory methodData = abi.encodeWithSignature("approve(address,uint256)", _spender, totalAllowance);

        invokeWallet(_wallet, _token, 0, methodData);
        invokeWallet(_wallet, _contract, 0, _data);

        // Calculate the approved amount that was spent after the call
        uint256 unusedAllowance = ERC20(_token).allowance(_wallet, _spender);
        uint256 usedAllowance = SafeMath.sub(totalAllowance, unusedAllowance);
        // Ensure the amount spent does not exceed the amount approved for this call
        require(usedAllowance <= _amount, "BT: insufficient amount for call");

        if (unusedAllowance != existingAllowance) {
            // Restore the original allowance amount if the amount spent was different (can be lower).
            methodData = abi.encodeWithSignature("approve(address,uint256)", _spender, existingAllowance);
            invokeWallet(_wallet, _token, 0, methodData);
        }

        emit ApprovedAndCalledContract(
            _wallet,
            _contract,
            _spender,
            _token,
            _amount,
            usedAllowance,
            _data);
    }
}
