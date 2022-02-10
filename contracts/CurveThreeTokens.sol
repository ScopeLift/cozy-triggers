pragma solidity ^0.8.5;

import "./interfaces/ICurvePool.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/ITrigger.sol";

/**
 * @notice Defines a trigger that is toggled if any of the following conditions occur:
 *   1. Curve LP token balances are significantly lower than what the pool expects them to be
 *   2. Curve pool virtual price drops significantly
 */
contract CurveThreeTokens is ITrigger {
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

    // immutables can't be read at construction, so we don't use `curve` in storage directly
    token0 = IERC20(ICurvePool(_curve).coins(0));
    token1 = IERC20(ICurvePool(_curve).coins(1));
    token2 = IERC20(ICurvePool(_curve).coins(2));

    // Save current virtual price, to be compared during checks
    lastVirtualPrice = ICurvePool(_curve).get_virtual_price();
  }

  // --- Trigger condition ---

  /**
   * @dev Checks the Curve LP token balances and virtual price
   */
  function checkTriggerCondition() internal override returns (bool) {
    // Read this blocks virtual price
    uint256 _currentVirtualPrice = curve.get_virtual_price();

    // Check trigger conditions. We could check one at a time and return as soon as one is true, but it is convenient
    // to have the data that caused the trigger saved into the state, so we don't do that
    bool _statusVirtualPrice = _currentVirtualPrice < ((lastVirtualPrice * virtualPriceTol) / scale);
    bool _statusBalances = checkCurveBalances();

    // Save the new data
    lastVirtualPrice = _currentVirtualPrice;

    // Return status
    return _statusVirtualPrice || _statusBalances;
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
