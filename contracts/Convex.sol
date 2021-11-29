pragma solidity ^0.8.9;

import "./interfaces/IERC20.sol";
import "./interfaces/ITrigger.sol";
import "./interfaces/IConvexBooster.sol";
import "./interfaces/ICurvePool.sol";

import "hardhat/console.sol";

interface ICurveToken is IERC20 {
  function minter() external view returns (address);
}

interface ICurveMetaPool is ICurvePool {
  function base_pool() external view returns (address);
}

/**
 * @notice Defines a trigger that is toggled if any of the following conditions occur:
 *   1. Underlying Curve pool token balances are significantly lower than what the pool expects them to be
 *   2. Underlying Curve pool virtual price drops significantly
 *   3. The price per share for the V2 yVault significantly decreases between consecutive checks. Under normal
 *      operation, this value should only increase. A decrease indicates someathing is wrong with the Yearn vault
 * @dev This trigger is for Convex pools that use a standard Curve pool (i.e. not a metapool)
 */
contract Convex is ITrigger {
  uint256 public constant scale = 1000; // scale used to define percentages, percentages are defined as tolerance / scale
  uint256 public constant virtualPriceTol = scale - 500; // 50% drop to consider trigger toggled

  address public constant convex = 0xF403C135812408BFbE8713b5A23a04b3D48AAE31; // Convex deposit contract (booster)
  uint256 public immutable convexPoolId; // Convex deposit contract (booster) pool id
  address public immutable curveBasePool; // Base Curve pool
  address public immutable curveMetaPool; // Curve meta pool

  uint256 public lastVpBasePool; // last virtual price read from base pool
  uint256 public lastVpMetaPool; // last virtual price read from meta pool

  /**
   * @param _convexPoolId TODO
   * @dev For definitions of other constructor parameters, see ITrigger.sol
   */
  constructor(
    string memory _name,
    string memory _symbol,
    string memory _description,
    uint256[] memory _platformIds,
    address _recipient,
    uint256 _convexPoolId
  ) ITrigger(_name, _symbol, _description, _platformIds, _recipient) {
    // Get curve base pool address from the pool ID
    convexPoolId = _convexPoolId;
    (address _curveLpToken, , , , , ) = IConvexBooster(convex).poolInfo(convexPoolId);
    curveMetaPool = ICurveToken(_curveLpToken).minter();
    curveBasePool = ICurveMetaPool(curveMetaPool).base_pool();

    // Get virtual prices
    lastVpMetaPool = ICurvePool(curveMetaPool).get_virtual_price();
    lastVpBasePool = ICurvePool(curveBasePool).get_virtual_price();
  }

  function checkTriggerCondition() internal override returns (bool) {
    // Read this blocks share price and virtual price
    console.log("curveMetaPool %s", curveMetaPool);
    console.log("curveBasePool %s", curveBasePool);
    uint256 _newVpMetaPool = ICurvePool(curveMetaPool).get_virtual_price();
    uint256 _newVpBasePool = ICurvePool(curveBasePool).get_virtual_price();

    // Check trigger conditions. We could check one at a time and return as soon as one is true, but it is convenient
    // to have the data that caused the trigger saved into the state, so we don't do that
    bool _statusVpMetaPool = _newVpMetaPool < ((lastVpMetaPool * virtualPriceTol) / scale);
    bool _statusVpBasePool = _newVpBasePool < ((lastVpBasePool * virtualPriceTol) / scale);

    // Save the new data
    lastVpMetaPool = _newVpMetaPool;
    lastVpBasePool = _newVpBasePool;

    // Return status
    return _statusVpMetaPool || _statusVpBasePool;
  }
}
