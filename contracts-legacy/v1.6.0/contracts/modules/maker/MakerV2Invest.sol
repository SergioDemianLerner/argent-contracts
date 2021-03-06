// Copyright (C) 2019  Argent Labs Ltd. <https://argent.xyz>

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

pragma solidity ^0.5.4;
import "./MakerV2Base.sol";

/**
 * @title MakerV2Invest
 * @dev Module to lock/unlock MCD DAI into/from Maker's Pot
 * @author Olivier VDB - <olivier@argent.xyz>
 */
contract MakerV2Invest is MakerV2Base {

    // The address of the Pot
    PotLike internal pot;

    // *************** Events ********************** //

    // WARNING: in a previous version of this module, the third parameter of `InvestmentRemoved`
    // represented the *fraction* (out of 10000) of the investment withdrawn, not the absolute amount withdrawn
    event InvestmentRemoved(address indexed _wallet, address _token, uint256 _amount);
    event InvestmentAdded(address indexed _wallet, address _token, uint256 _amount, uint256 _period);

    // *************** Constructor ********************** //

    constructor(PotLike _pot) public {
        pot = _pot;
    }

    // *************** External/Public Functions ********************* //

    /**
    * @dev Lets the wallet owner deposit MCD DAI into the DSR Pot.
    * @param _wallet The target wallet.
    * @param _amount The amount of DAI to deposit
    */
    function joinDsr(
        BaseWallet _wallet,
        uint256 _amount
    )
        external
        onlyWalletOwner(_wallet)
        onlyWhenUnlocked(_wallet)
    {
        // Execute drip to get the chi rate updated to rho == now, otherwise join will fail
        pot.drip();
        // Approve DAI adapter to take the DAI amount
        invokeWallet(address(_wallet), address(daiToken), 0, abi.encodeWithSignature("approve(address,uint256)", address(daiJoin), _amount));
        // Join DAI into the vat (_amount of external DAI is burned and the vat transfers _amount of internal DAI from the adapter to the _wallet)
        invokeWallet(address(_wallet), address(daiJoin), 0, abi.encodeWithSignature("join(address,uint256)", address(_wallet), _amount));
        // Approve the pot to take out (internal) DAI from the wallet's balance in the vat
        grantVatAccess(_wallet, address(pot));
        // Compute the pie value in the pot
        uint256 pie = _amount.mul(RAY) / pot.chi();
        // Join the pie value to the pot
        invokeWallet(address(_wallet), address(pot), 0, abi.encodeWithSignature("join(uint256)", pie));
        // Emitting event
        emit InvestmentAdded(address(_wallet), address(daiToken), _amount, 0);
    }

    /**
    * @dev Lets the wallet owner withdraw MCD DAI from the DSR pot.
    * @param _wallet The target wallet.
    * @param _amount The amount of DAI to withdraw.
    */
    function exitDsr(
        BaseWallet _wallet,
        uint256 _amount
    )
        external
        onlyWalletOwner(_wallet)
        onlyWhenUnlocked(_wallet)
    {
        // Execute drip to count the savings accumulated until this moment
        pot.drip();
        // Calculates the pie value in the pot equivalent to the DAI wad amount
        uint256 pie = _amount.mul(RAY) / pot.chi();
        // Exit DAI from the pot
        invokeWallet(address(_wallet), address(pot), 0, abi.encodeWithSignature("exit(uint256)", pie));
        // Allow adapter to access the _wallet's DAI balance in the vat
        grantVatAccess(_wallet, address(daiJoin));
        // Check the actual balance of DAI in the vat after the pot exit
        uint bal = vat.dai(address(_wallet));
        // It is necessary to check if due to rounding the exact _amount can be exited by the adapter.
        // Otherwise it will do the maximum DAI balance in the vat
        uint256 withdrawn = bal >= _amount.mul(RAY) ? _amount : bal / RAY;
        invokeWallet(address(_wallet), address(daiJoin), 0, abi.encodeWithSignature("exit(address,uint256)", address(_wallet), withdrawn));
        // Emitting event
        emit InvestmentRemoved(address(_wallet), address(daiToken), withdrawn);
    }

    /**
    * @dev Lets the wallet owner withdraw their entire MCD DAI balance from the DSR pot.
    * @param _wallet The target wallet.
    */
    function exitAllDsr(
        BaseWallet _wallet
    )
        external
        onlyWalletOwner(_wallet)
        onlyWhenUnlocked(_wallet)
    {
        // Execute drip to count the savings accumulated until this moment
        pot.drip();
        // Gets the total pie belonging to the _wallet
        uint256 pie = pot.pie(address(_wallet));
        // Exit DAI from the pot
        invokeWallet(address(_wallet), address(pot), 0, abi.encodeWithSignature("exit(uint256)", pie));
        // Allow adapter to access the _wallet's DAI balance in the vat
        grantVatAccess(_wallet, address(daiJoin));
        // Exits the DAI amount corresponding to the value of pie
        uint256 withdrawn = pot.chi().mul(pie) / RAY;
        invokeWallet(address(_wallet), address(daiJoin), 0, abi.encodeWithSignature("exit(address,uint256)", address(_wallet), withdrawn));
        // Emitting event
        emit InvestmentRemoved(address(_wallet), address(daiToken), withdrawn);
    }

    /**
    * @dev Returns the amount of DAI currently held in the DSR pot.
    * @param _wallet The target wallet.
    * @return The DSR balance.
    */
    function dsrBalance(BaseWallet _wallet) external view returns (uint256 _balance) {
        return pot.chi().mul(pot.pie(address(_wallet))) / RAY;
    }

    /* ****************************************** Internal method ******************************************* */

    /**
    * @dev Grant access to the wallet's internal DAI balance in the VAT to an operator.
    * @param _wallet The target wallet.
    * @param _operator The grantee of the access
    */
    function grantVatAccess(BaseWallet _wallet, address _operator) internal {
        if (vat.can(address(_wallet), _operator) == 0) {
            invokeWallet(address(_wallet), address(vat), 0, abi.encodeWithSignature("hope(address)", _operator));
        }
    }
}