pragma solidity ^0.8.5;

import "../interfaces/ICrvTricrypto.sol";

/**
 * @notice Mock Curve Tricrypto pool, containing the same interface but configurable parameters for testing
 */
contract MockCrvTricrypto is ICrvTricrypto {
  uint256 public override get_virtual_price;
  uint256 public override virtual_price;
  uint256 public override xcp_profit;
  uint256 public override xcp_profit_a;
  uint256 public override admin_fee;

  constructor() {
    // Initializing the values based on the actual values on 2021-07-15
    get_virtual_price = 1001041521509972624;
    virtual_price = 1001041521509972624;
    xcp_profit = 1001056295181177762;
    xcp_profit_a = 1001035776942422073;
    admin_fee = 5000000000;
  }

  /**
   * @notice Set the pricePerShare
   * @param _get_virtual_price New get_virtual_price value
   */
  function set(uint256 _get_virtual_price) external {
    get_virtual_price = _get_virtual_price;
  }
}
