pragma solidity ^0.8.10;

import "../shared/interfaces/ICurvePool.sol";
import "../shared/interfaces/IERC20.sol";
import "../shared/interfaces/ITrigger.sol";

/**
 * @notice Defines a trigger for a Curve base pool that is toggled if any of the following conditions occur:
 *   1. Curve LP token balances are significantly lower than what the pool expects them to be
 *   2. Curve pool virtual price drops significantly
 */
contract CurveThreeTokenBasePool is ITrigger {
  // --- Tokens ---
  // Underlying token addresses
  IERC20 internal immutable token0;
  IERC20 internal immutable token1;
  IERC20 internal immutable token2;

  // --- Tolerances ---
  /// @dev Scale used to define percentages. Percentages are defined as tolerance / scale
  uint256 public constant scale = 1000;

  /// @dev Consider trigger toggled if Curve virtual price drops by this percentage.
  /// per share, the virtual price is expected to decrease during normal operation, but it should never decrease by
  /// more than 50% during normal operation. Therefore we check for a 50% drop
  uint256 public constant virtualPriceTol = scale - 500; // 50% drop

  /// @dev Consider trigger toggled if Curve internal balances are lower than true balances by this percentage
  uint256 public constant balanceTol = scale - 500; // 50% drop

  // --- Trigger Data ---

  /// @notice Curve pool
  ICurvePool public immutable curve;

  /// @notice Last read curve virtual price
  uint256 public lastVirtualPrice;

  // --- Constructor ---

  /**
   * @param _curve Address of the Curve pool
   * @dev For definitions of other constructor parameters, see ITrigger.sol
   */
  constructor(
    string memory _name,
    string memory _symbol,
    string memory _description,
    uint256[] memory _platformIds,
    address _recipient,
    address _curve
  ) ITrigger(_name, _symbol, _description, _platformIds, _recipient) {
    curve = ICurvePool(_curve);

    token0 = IERC20(curve.coins(0));
    token1 = IERC20(curve.coins(1));
    token2 = IERC20(curve.coins(2));

    // Save current virtual price, to be compared during checks
    lastVirtualPrice = curve.get_virtual_price();
  }

  // --- Trigger condition ---

  /**
   * @dev Checks the Curve LP token balances and virtual price
   */
  function checkTriggerCondition() internal override returns (bool) {
    // Internal balance vs. true balance check
    if (checkCurveBalances()) return true;

    // Pool virtual price check
    try curve.get_virtual_price() returns (uint256 _newVirtualPrice) {
      bool _triggerVpPool = _newVirtualPrice < ((lastVirtualPrice * virtualPriceTol) / scale);
      if (_triggerVpPool) return true;
      lastVirtualPrice = _newVirtualPrice; // if not triggered, save off the virtual price for the next call
    } catch {
      return true;
    }

    // Trigger condition has not occured
    return false;
  }

  /**
   * @dev Checks if the Curve internal balances are significantly lower than the true balances
   * @return True if balances are out of tolerance and trigger should be toggled
   */
  function checkCurveBalances() internal view returns (bool) {
    return
      (token0.balanceOf(address(curve)) < ((curve.balances(0) * balanceTol) / scale)) ||
      (token1.balanceOf(address(curve)) < ((curve.balances(1) * balanceTol) / scale)) ||
      (token2.balanceOf(address(curve)) < ((curve.balances(2) * balanceTol) / scale));
  }
}
