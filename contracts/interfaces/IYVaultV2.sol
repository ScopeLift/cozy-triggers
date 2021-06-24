pragma solidity ^0.8.5;

interface IYVaultV2 {
  function pricePerShare() external view returns (uint256);
}
