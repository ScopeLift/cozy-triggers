pragma solidity ^0.8.5;

import "./interfaces/ICrvTricrypto.sol";
import "./interfaces/IYVaultV2.sol";
import "./interfaces/ITrigger.sol";

/**
 * @notice Defines a trigger that is toggled if any of the following conditions occur:
 *   1. The price per share for the V2 yVault significantly decreases between consecutive checks. Under normal
 *      operation, this value should only increase. A decrease indicates something is wrong with the Yearn vault
 *   2. Curve Tricrypto price checks. 50% threshold? Leave this out for now
 *   3. Curve Tricrypto virtual price equation
 */
contract YearnCrvTricrypto is ITrigger {
  /// @notice Yearn vault this trigger is for
  IYVaultV2 public immutable vault;

  /// @notice Curve tricrypto pool used as a strategy by `vault`
  ICrvTricrypto public immutable curve;

  /// @notice Last read pricePerShare
  uint256 public lastPricePerShare;

  /// @notice Last read curve virtual price
  uint256 public lastVirtualPrice;

  /// @dev Scale used to define percentages
  uint256 public constant scale = 1000;

  /// @dev In Yearn V2 vaults, the pricePerShare decreases immediately after a harvest, and typically ramps up over the
  /// next six hours. Therefore we cannot simply check that the pricePerShare increases. Instead, we consider the vault
  /// triggered if the pricePerShare drops by more than 50% from it's previous value. This is conservative, but
  /// previous Yearn bugs resulted in pricePerShare drops of 0.5% – 10%, and were only temporary drops with users able
  /// to be made whole. Therefore this trigger requires a large 50% drop to minimize false positives. The tolerance
  /// is defined such that we trigger if: currentPricePerShare < lastPricePerShare * tolerance / 1000. This means
  /// if you want to trigger after a 20% drop, you should set the tolerance to 1000 - 200 = 800
  uint256 public constant vaultTol = scale - 500; // 50% drop, represented on a scale where 1000 = 100%

  /// @dev Consider trigger toggled if Curve virtual price drops by this percentage
  uint256 public constant curveTol = scale - 750; // 75% drop, since 1000-750=250, and multiplying by 0.25 = 75% drop

  /**
   * @param _vault Address of the Yearn V2 vault this trigger should protect
   * @param _curve Address of the Curve Tricrypto pool uses by the above Yearn vault
   * @dev For definitions of other constructor parameters, see ITrigger.sol
   */
  constructor(
    string memory _name,
    string memory _symbol,
    string memory _description,
    uint256[] memory _platformIds,
    address _recipient,
    address _vault,
    address _curve
  ) ITrigger(_name, _symbol, _description, _platformIds, _recipient) {
    // Set vault
    vault = IYVaultV2(_vault);
    curve = ICrvTricrypto(_curve);

    // Save current values (immutables can't be read at construction, so we don't use `vault` or `curve` directly)
    lastPricePerShare = IYVaultV2(_vault).pricePerShare();
    lastVirtualPrice = ICrvTricrypto(_curve).get_virtual_price();
  }

  /**
   * @dev Checks the yVault pricePerShare
   */
  function checkTriggerCondition() internal override returns (bool) {
    // Read this blocks share price and virtual price
    uint256 _currentPricePerShare = vault.pricePerShare();
    uint256 _currentVirtualPrice = curve.get_virtual_price();

    // Check trigger conditions
    bool _statusVault = _currentPricePerShare < ((lastPricePerShare * vaultTol) / scale);
    bool _statusCurve = _currentVirtualPrice < ((lastVirtualPrice * curveTol) / scale);

    // Save the new data
    lastPricePerShare = _currentPricePerShare;
    lastVirtualPrice = _currentVirtualPrice;

    // Return status
    return _statusVault || _statusCurve;
  }
}
