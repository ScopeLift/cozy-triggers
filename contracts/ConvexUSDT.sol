pragma solidity ^0.8.9;

import "./interfaces/IERC20.sol";
import "./interfaces/ITrigger.sol";
import "./interfaces/IConvexBooster.sol";

interface ICrvTokenUSDT is IERC20 {
  function minter() external view returns (address);
}

interface ICrvPoolUSDT {
  function balances(int128 index) external view returns (uint256);

  function coins(int128 index) external view returns (address);

  function get_virtual_price() external view returns (uint256);
}

interface ICrvMetaPoolUSDT {
  function balances(uint256 index) external view returns (uint256);

  function base_pool() external view returns (address);

  function coins(uint256 index) external view returns (address);

  function get_virtual_price() external view returns (uint256);
}

/**
 * @notice Defines a trigger that is toggled if any of the following conditions occur:
 *   1. Underlying Curve pool token balances are significantly lower than what the pool expects them to be
 *   2. Underlying Curve pool virtual price drops significantly
 *   3. The price per share for the V2 yVault significantly decreases between consecutive checks. Under normal
 *      operation, this value should only increase. A decrease indicates someathing is wrong with the Yearn vault
 * @dev This trigger is for Convex pools that use a standard Curve pool (i.e. not a metapool)
 */
contract ConvexUSDT is ITrigger {
  uint256 public constant scale = 1000; // scale used to define percentages, percentages are defined as tolerance / scale
  uint256 public constant virtualPriceTol = scale - 500; // toggle if virtual price drops by >50%
  uint256 public constant balanceTol = scale - 500; // toggle if true balances are >50% lower than internally tracked balances
  address public constant convex = 0xF403C135812408BFbE8713b5A23a04b3D48AAE31; // Convex deposit contract (booster)

  uint256 public immutable convexPoolId; // Convex deposit contract (booster) pool id
  address public immutable convexToken; // Convex receipt token minted on deposits
  address public immutable staker; // Convex contract that manages staking
  address public immutable gauge; // Curve gauge that Convex deposits into

  address public immutable curveMetaPool; // Curve meta pool
  address public immutable curveBasePool; // Base Curve pool

  address public immutable metaToken0;
  address public immutable metaToken1;

  address public immutable baseToken0;
  address public immutable baseToken1;
  address public immutable baseToken2;

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
    // Get addresses from the pool ID
    (address _curveLpToken, address _convexToken, address _gauge, , , ) = IConvexBooster(convex).poolInfo(
      _convexPoolId
    );
    staker = IConvexBooster(convex).staker();
    convexPoolId = _convexPoolId;
    convexToken = _convexToken;
    gauge = _gauge;

    curveMetaPool = ICrvTokenUSDT(_curveLpToken).minter();
    curveBasePool = ICrvMetaPoolUSDT(curveMetaPool).base_pool();

    metaToken0 = ICrvMetaPoolUSDT(curveMetaPool).coins(0);
    metaToken1 = ICrvMetaPoolUSDT(curveMetaPool).coins(1);

    baseToken0 = ICrvPoolUSDT(curveBasePool).coins(0);
    baseToken1 = ICrvPoolUSDT(curveBasePool).coins(1);
    baseToken2 = ICrvPoolUSDT(curveBasePool).coins(2);

    // Get virtual prices
    lastVpMetaPool = ICrvPoolUSDT(curveMetaPool).get_virtual_price();
    lastVpBasePool = ICrvPoolUSDT(curveBasePool).get_virtual_price();
  }

  function checkTriggerCondition() internal override returns (bool) {
    // Typically in this method we check all conditions, save them to storage, amd return the result.
    // This is convenient because it ensures we have the data that caused the trigger saved into
    // the state, but this is just convenient and not a requirement. We do not follow that pattern
    // here because  certain trigger conditions can cause this method to revert if we tried that
    // (and a revert means the trigger can never toggle). Instead, we check conditions one at a
    // time, and return immediately if a trigger condition is met.
    //
    // Specifically, imagine the failure case where the base pool is hacked, and the attacker is
    // able to mint 2^128 LP tokens for themself. When this trigger contract calls get_virtual_price()
    // on the meta pool, it will revert. This revert happens as follows:
    //   1. The base pool will have a virtual price close to zero (or zero, depending on the new
    //      total supply). This value is the vp_rate variable in the meta pool's get_virtual_price() method
    //   2. This virtual price is passed into the self._xp() method, which multiplies this by
    //      the metacurrency token balance then divides by PRECISION. If virtual price is too
    //      small relative to the PRECISION, the integer division is floored, returning zero.
    //   3. This xp value of zero is passed into self._get_D(), and is used in division. We of
    //      course cannot divide by zero, so the call reverts
    //
    // Given this potential failure mode, we check trigger conditions as follows:
    //   1. First we do the balance checks since that check cannot revert
    //   2. Next we check the virtual price of that base pool. This can still revert if the balance of
    //      a token is too low, resulting in a zero value for xp leading to division by zero, but
    //      because we already checked that balances are not too low this should be safe.
    //      NOTE: There is a potential edge case where a token balance decrease is less than our 50%
    //      threshold so the balance trigger condition is not toggled, BUT the balance is low enough
    //      that xp is still floored to zero during integer division, resulting in a revert. More
    //      analysis (or perhaps just a thorough understanding of Curve internals?) is needed to
    //      ensure this is not possible.
    //      NOTE: In a properly functioning curve market, get_virtual_price() should never revert.
    //      Therefore, all external calls are wrapped in a try/catch, and if the call reverts then
    //      something is wrong with the underlying protocol and we toggle the trigger
    //   3. Lastly we check the virtual price of the meta pool for similar reasons to above
    //
    // For try/catch blocks, we return early if the trigger condition was met. If it wasn't, we
    // save off the new state variable. This can result in "inconsistent" states after a trigger
    // occurs. For example, if the first check is ok, but the second check fails, the final state
    // of this contract will have the new state from the first check, but the prior state from the
    // second (failed) check (i.e. not the most recent check that triggered the). This is a bit
    // awkward, but ultimatly is not a problem

    // Verify supply of Convex receipt tokens is equal to the amount of curve receipt tokens Convex
    // can claim. Convex receipt tokens are minted 1:1 with deposited funds, so this protects
    // against e.g. "infinite mint" type bugs, where an attacker is able to mint themselves more
    // Convex receipt tokens than what they should receive.
    if (IERC20(convexToken).totalSupply() != IERC20(gauge).balanceOf(staker)) return true;

    // Token balance checks
    if (checkCurveBaseBalances()) return true;
    if (checkCurveMetaBalances()) return true;

    // Base pool virtual price
    try ICrvPoolUSDT(curveBasePool).get_virtual_price() returns (uint256 _newVpBasePool) {
      bool _triggerVpBasePool = _newVpBasePool < ((lastVpBasePool * virtualPriceTol) / scale);
      if (_triggerVpBasePool) return true;
      lastVpBasePool = _newVpBasePool; // if not triggered, save off the virtual price for the next call
    } catch {
      return true;
    }

    // Meta pool virtual price
    try ICrvPoolUSDT(curveMetaPool).get_virtual_price() returns (uint256 _newVpMetaPool) {
      bool _triggerVpMetaPool = _newVpMetaPool < ((lastVpMetaPool * virtualPriceTol) / scale);
      if (_triggerVpMetaPool) return true;
      lastVpMetaPool = _newVpMetaPool; // if not triggered, save off the virtual price for the next call
    } catch {
      return true;
    }

    // Trigger condition has not occured
    return false;
  }

  /**
   * @dev Checks if the Curve base pool internal balances are significantly lower than the true balances
   * @return True if balances are out of tolerance and trigger should be toggled
   */
  function checkCurveBaseBalances() internal view returns (bool) {
    return
      (IERC20(baseToken0).balanceOf(curveBasePool) <
        ((ICrvPoolUSDT(curveBasePool).balances(0) * balanceTol) / scale)) ||
      (IERC20(baseToken1).balanceOf(curveBasePool) <
        ((ICrvPoolUSDT(curveBasePool).balances(1) * balanceTol) / scale)) ||
      (IERC20(baseToken2).balanceOf(curveBasePool) < ((ICrvPoolUSDT(curveBasePool).balances(2) * balanceTol) / scale));
  }

  /**
   * @dev Checks if the Curve meta pool internal balances are significantly lower than the true balances
   * @return True if balances are out of tolerance and trigger should be toggled
   */
  function checkCurveMetaBalances() internal view returns (bool) {
    return
      (IERC20(metaToken0).balanceOf(curveMetaPool) <
        ((ICrvMetaPoolUSDT(curveMetaPool).balances(0) * balanceTol) / scale)) ||
      (IERC20(metaToken1).balanceOf(curveMetaPool) <
        ((ICrvMetaPoolUSDT(curveMetaPool).balances(1) * balanceTol) / scale));
  }
}
