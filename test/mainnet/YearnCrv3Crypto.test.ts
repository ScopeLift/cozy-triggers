// --- Imports ---
import { artifacts, ethers, network, waffle } from 'hardhat';
import { expect } from 'chai';
import type { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { keccak256 } from '@ethersproject/keccak256';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { MockCozyToken, IYVaultV2, ICurvePool, YearnCrv3Crypto, IERC20 } from '../../typechain';
import { reset } from '../../utils/utils';

// --- Constants and extracted methods ---
const { deployContract, loadFixture } = waffle;
const { MaxUint256: MAX_UINT } = ethers.constants;
const { defaultAbiCoder, hexZeroPad, hexStripZeros } = ethers.utils;
const BN = (x: BigNumberish) => ethers.BigNumber.from(x);
const to32ByteHex = (x: BigNumberish) => hexZeroPad(BN(x).toHexString(), 32);
const yearnVaultAddress = '0xE537B5cc158EB71037D4125BDD7538421981E6AA'; // mainnet Yearn crv3Crypto vault
const curve3CryptoAddress = '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46'; // mainnet Curve 3Crypto pool
const curveTokenAddress = '0xc4AD29ba4B3c580e6D59105FFf484999997675Ff'; // Curve 3Crypto pool token

// Mainnet token addresses
const tokenAddresses = {
  usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
};

// Define the balanceOf mapping slot number to use for finding the slot used to store balance of a given address
const tokenBalanceOfSlots = { usdt: '0x2', wbtc: '0x0', weth: '0x3' };

// --- Helper methods ---
// Returns the storage slot for a mapping from an `address` to a value, given the slot of the mapping itself, `mappingSlot`
// Read more at https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#mappings-and-dynamic-arrays
const getStorageSlot = (mappingSlot: string, address: string) => {
  // `defaultAbiCoder.encode` is equivalent to Solidity's `abi.encode()`, and we strip leading zeros from the hashed
  // value to conform to the JSON-RPC spec: https://ethereum.org/en/developers/docs/apis/json-rpc/#hex-value-encoding
  return hexStripZeros(keccak256(defaultAbiCoder.encode(['address', 'uint256'], [address, mappingSlot])));
};

// Gets token balance
async function balanceOf(token: keyof typeof tokenBalanceOfSlots, address: string) {
  const tokenAddress = tokenAddresses[token];
  if (!tokenAddress) throw new Error('Invalid token selection');
  const abi = ['function balanceOf(address) external view returns (uint256)'];
  const contract = new ethers.Contract(tokenAddress, abi, ethers.provider);
  return (await contract.balanceOf(address)).toBigInt();
}

describe('YearnCrv3Crypto', function () {
  // --- Data ---
  let yCrv3Crypto: IYVaultV2;
  let crv3Crypto: ICurvePool;
  let crvToken: IERC20;
  let deployer: SignerWithAddress;
  let trigger: YearnCrv3Crypto;
  let triggerParams: (string | number[])[] = []; // trigger params deployment parameters

  // --- Functions modifying storage ---
  /**
   * @notice Change Yearn vault's price per share by modifying total supply (since share price is a getter method that
   * divides by total token supply)
   * @param supply New total supply. To zero out share price, use MAX_UINT256, which simulates unlimited minting of
   * shares, making price per share effectively 0
   */
  async function setYearnTotalSupply(supply: BigNumberish) {
    const storageSlot = '0x5'; // storage slot 5 in Yearn vault contains total supply
    await network.provider.send('hardhat_setStorageAt', [yearnVaultAddress, storageSlot, to32ByteHex(supply)]);
  }

  /**
   * @notice Change Curve pool's virtual price by modifying total supply (since virtual price is a getter method that
   * divides by total token supply)
   * @param supply New total supply. To zero out share price, use MAX_UINT256, which simulates unlimited minting of
   * shares, making price per share effectively 0
   */
  async function setCrvTotalSupply(supply: BigNumberish) {
    const storageSlot = '0x4'; // storage slot 4 is Curve token total supply
    await network.provider.send('hardhat_setStorageAt', [curveTokenAddress, storageSlot, to32ByteHex(supply)]);
  }

  /**
   * @notice Modify the balance of a token in the Curve pool
   * @param token Token symbol
   * @param balance New balance to set
   */
  async function modifyCrvBalance(token: keyof typeof tokenBalanceOfSlots, numerator: bigint, denominator: bigint) {
    const value = ((await balanceOf(token, curve3CryptoAddress)) * numerator) / denominator;
    const tokenAddress = tokenAddresses[token];
    if (!tokenAddress) throw new Error('Invalid token selection');
    const mappingSlot = tokenBalanceOfSlots[token];
    const storageSlot = getStorageSlot(mappingSlot, curve3CryptoAddress);
    await network.provider.send('hardhat_setStorageAt', [tokenAddress, storageSlot, to32ByteHex(value)]);
  }

  // --- Test fixture ---

  // Executes checkAndToggleTrigger and verifies the expected state
  async function assertTriggerStatus(status: boolean) {
    await trigger.checkAndToggleTrigger();
    expect(await trigger.isTriggered()).to.equal(status);
  }

  /**
   * @dev We change the values in storage slots of mainnet contracts in our tests, and normally these would persist
   * between tests. But we don't want that, so we use this fixture to automatically snapshot the state after loading
   * the fixture and revert to it before each test: https://github.com/EthWorks/Waffle/blob/3f46a6c8093cb9edb1a68c3ba15c4b4499ad595d/waffle-provider/src/fixtures.ts#L13-L35
   */
  async function setupFixture() {
    // Get user accounts
    const [deployer, recipient] = await ethers.getSigners();

    // Get mainnet contract instances
    const yCrv3Crypto = <IYVaultV2>await ethers.getContractAt('IYVaultV2', yearnVaultAddress);
    const crv3Crypto = <ICurvePool>await ethers.getContractAt('ICurvePool', curve3CryptoAddress);
    const crvToken = <IERC20>await ethers.getContractAt('IERC20', curveTokenAddress);

    // Deploy YearnCrv3Crypto trigger
    const triggerParams = [
      'Yearn Curve 3Crypto Trigger', // name
      'yCRV-3CRYPTO-TRIG', // symbol
      "Triggers when the Yearn vault share price decreases by more than 50% between consecutive checks, the Curve 3Crypto pool's virtual price decreases by more than 50% between consecutive checks, or the internal balances tracked in the Curve 3Crypto pool are more than 50% lower than the true balances", // description
      [1, 3], // platform IDs for Yearn and Curve, respectively
      recipient.address, // subsidy recipient
      yearnVaultAddress, // mainnet Yearn crv3Crypto vault
      curve3CryptoAddress, // mainnet Curve 3Crypto pool
    ];

    const YearnCrv3CryptoArtifact = await artifacts.readArtifact('YearnCrv3Crypto');
    const trigger = <YearnCrv3Crypto>await deployContract(deployer, YearnCrv3CryptoArtifact, triggerParams);

    return { deployer, yCrv3Crypto, crv3Crypto, crvToken, trigger, triggerParams };
  }

  // --- Tests ---
  before(async () => {
    // Ensure mainnet is re-forked before test execution to ensure storage slot state isolation
    await reset();
  });

  beforeEach(async () => {
    ({ deployer, yCrv3Crypto, crv3Crypto, crvToken, trigger, triggerParams } = await loadFixture(setupFixture));
  });

  describe('Deployment', () => {
    it('initializes properly', async () => {
      expect(await trigger.name()).to.equal(triggerParams[0]);
      expect(await trigger.symbol()).to.equal(triggerParams[1]);
      expect(await trigger.description()).to.equal(triggerParams[2]);
      const platformIds = (await trigger.getPlatformIds()).map((id: BigNumber) => id.toNumber());
      expect(platformIds).to.deep.equal(triggerParams[3]); // use `.deep.equal` to compare array equality
      expect(await trigger.recipient()).to.equal(triggerParams[4]);
      expect(await trigger.vault()).to.equal(triggerParams[5]);
      expect(await trigger.curve()).to.equal(triggerParams[6]);
      expect(await trigger.vaultTol()).to.equal('500');
      expect(await trigger.virtualPriceTol()).to.equal('500');
    });
  });

  describe('checkAndToggleTrigger', () => {
    it('does nothing when called on a valid market', async () => {
      expect(await trigger.isTriggered()).to.be.false;
      await trigger.checkAndToggleTrigger();
      expect(await trigger.isTriggered()).to.be.false;
    });

    it('toggles trigger when called on a broken market', async () => {
      expect(await trigger.isTriggered()).to.be.false;

      await setYearnTotalSupply(MAX_UINT);
      expect(await trigger.isTriggered()).to.be.false; // trigger not updated yet, so still expect false

      const tx = await trigger.checkAndToggleTrigger();
      await expect(tx).to.emit(trigger, 'TriggerActivated');
      expect(await trigger.isTriggered()).to.be.true;
    });

    it('returns a boolean with the value of isTriggered', async () => {
      // Deploy our helper contract for testing, which has a state variable called isTriggered that stores the last
      // value returned from trigger.checkAndToggleTrigger()
      const mockCozyTokenArtifact = await artifacts.readArtifact('MockCozyToken');
      const mockCozyToken = <MockCozyToken>await deployContract(deployer, mockCozyTokenArtifact, [trigger.address]);
      expect(await mockCozyToken.isTriggered()).to.be.false;

      // Break the yVault
      await setYearnTotalSupply(MAX_UINT);
      await mockCozyToken.checkAndToggleTrigger();
      expect(await mockCozyToken.isTriggered()).to.be.true;
    });

    it('properly updates the saved state', async () => {
      // Update values
      await setYearnTotalSupply(10n ** 18n); // don't set them too high or trigger will toggle
      await setCrvTotalSupply(10n ** 18n);

      // Call checkAndToggleTrigger to simulate someone using the protocol
      await trigger.checkAndToggleTrigger();
      expect(await trigger.isTriggered()).to.be.false; // sanity check
      const newPricePerShare = await yCrv3Crypto.pricePerShare();
      const newVirtualPrice = await crv3Crypto.get_virtual_price();

      // Verify the new state
      const currentPricePerShare = await trigger.lastPricePerShare();
      expect(currentPricePerShare.toString()).to.equal(newPricePerShare.toString()); // bigint checks are flaky with chai
      const currentVirtualPrice = await trigger.lastVirtualPrice();
      expect(currentVirtualPrice.toString()).to.equal(newVirtualPrice.toString());
    });

    it('properly accounts for price per share tolerance', async () => {
      // Modify the currently stored share price by a set tolerance. To increase share price by a tolerance, we
      // decrease total supply by that amount
      async function modifyLastPricePerShare(numerator: bigint, denominator: bigint) {
        const lastPricePerShare = (await trigger.lastPricePerShare()).toBigInt();
        const lastTotalSupply = (await yCrv3Crypto.totalSupply()).toBigInt();
        const newTotalSupply = (lastTotalSupply * denominator) / numerator;
        const newPricePerShare = (lastPricePerShare * numerator) / denominator;
        await setYearnTotalSupply(newTotalSupply);
        // Due to rounding error, values may sometimes differ by 1 wei, so validate with a tolerance +/2 wei
        expect(await yCrv3Crypto.pricePerShare()).to.be.above(newPricePerShare - 2n);
        expect(await yCrv3Crypto.pricePerShare()).to.be.below(newPricePerShare + 2n);
      }

      // Read the trigger's tolerance
      const tolerance = (await trigger.vaultTol()).toBigInt();

      // Increase share price to a larger value, should NOT be triggered (sanity check)
      await modifyLastPricePerShare(101n, 100n); // 1% increase
      await assertTriggerStatus(false);

      // Decrease share price by an amount less than tolerance, should NOT be triggered
      await modifyLastPricePerShare(99n, 100n); // 1% decrease
      await assertTriggerStatus(false);

      // Decrease share price by an amount exactly equal to tolerance, should NOT be triggered
      await modifyLastPricePerShare(tolerance, 1000n);
      await assertTriggerStatus(false);

      // Decrease share price by an amount more than tolerance, should be triggered
      await modifyLastPricePerShare(tolerance - 1n, 1000n);
      await assertTriggerStatus(true);
    });

    it('properly accounts for virtual price tolerance', async () => {
      // Modify the currently stored virtual price by a set tolerance
      async function modifyLastVirtualPrice(numerator: bigint, denominator: bigint) {
        const lastVirtualPrice = (await trigger.lastVirtualPrice()).toBigInt();
        const lastTotalSupply = (await crvToken.totalSupply()).toBigInt();
        const newTotalSupply = (lastTotalSupply * denominator) / numerator;
        const newVirtualPrice = (lastVirtualPrice * numerator) / denominator;
        await setCrvTotalSupply(newTotalSupply);
        // Due to rounding error, values may sometimes differ by 1 wei, so validate with a tolerance +/2 wei
        expect(await crv3Crypto.get_virtual_price()).to.be.above(newVirtualPrice - 2n);
        expect(await crv3Crypto.get_virtual_price()).to.be.below(newVirtualPrice + 2n);
      }

      // Read the trigger's tolerance
      const tolerance = (await trigger.virtualPriceTol()).toBigInt();

      // Increase virtual price to a larger value, should NOT be triggered (sanity check)
      await modifyLastVirtualPrice(101n, 100n); // 1% increase
      await assertTriggerStatus(false);

      // Decrease virtual price by an amount less than tolerance, should NOT be triggered
      await modifyLastVirtualPrice(99n, 100n); // 1% decrease
      await assertTriggerStatus(false);

      // Decrease virtual price by an amount exactly equal to tolerance, should NOT be triggered
      await modifyLastVirtualPrice(tolerance, 1000n);
      await assertTriggerStatus(false);

      // Decrease virtual price by an amount more than tolerance, should be triggered
      await modifyLastVirtualPrice(tolerance - 1n, 1000n);
      await assertTriggerStatus(true);
    });

    it('properly accounts for USDT balance being drained', async () => {
      const token = 'usdt';
      const tolerance = (await trigger.balanceTol()).toBigInt();

      // Increase balance to a larger value, should NOT be triggered (sanity check)
      await modifyCrvBalance(token, 101n, 100n); // 1% increase
      await assertTriggerStatus(false);

      // Decrease balance by an amount less than tolerance, should NOT be triggered
      await modifyCrvBalance(token, 99n, 100n); // 1% decrease
      await assertTriggerStatus(false);

      // Decrease balance by an amount exactly slightly above tolerance, should NOT be triggered (we don't do
      // exact to account for flooring on integer division when dividing an odd number in half)
      await modifyCrvBalance(token, tolerance + 1n, 1000n);
      await assertTriggerStatus(false);

      // Decrease balance by an amount more than tolerance, should be triggered
      await modifyCrvBalance(token, tolerance - 1n, 1000n);
      await assertTriggerStatus(true);
    });

    it('properly accounts for WBTC balance being drained', async () => {
      const token = 'wbtc';
      const tolerance = (await trigger.balanceTol()).toBigInt();

      // Increase balance to a larger value, should NOT be triggered (sanity check)
      await modifyCrvBalance(token, 101n, 100n); // 1% increase
      await assertTriggerStatus(false);

      // Decrease balance by an amount less than tolerance, should NOT be triggered
      await modifyCrvBalance(token, 99n, 100n); // 1% decrease
      await assertTriggerStatus(false);

      // Decrease balance by an amount exactly slightly above tolerance, should NOT be triggered (we don't do
      // exact to account for flooring on integer division when dividing an odd number in half)
      await modifyCrvBalance(token, tolerance + 1n, 1000n);
      await assertTriggerStatus(false);

      // Decrease balance by an amount more than tolerance, should be triggered
      await modifyCrvBalance(token, tolerance - 1n, 1000n);
      await assertTriggerStatus(true);
    });

    it('properly accounts for WETH balance being drained', async () => {
      const token = 'weth';
      const tolerance = (await trigger.balanceTol()).toBigInt();

      // Increase balance to a larger value, should NOT be triggered (sanity check)
      await modifyCrvBalance(token, 101n, 100n); // 1% increase
      await assertTriggerStatus(false);

      // Decrease balance by an amount less than tolerance, should NOT be triggered
      await modifyCrvBalance(token, 99n, 100n); // 1% decrease
      await assertTriggerStatus(false);

      // Decrease balance by an amount exactly slightly above tolerance, should NOT be triggered (we don't do
      // exact to account for flooring on integer division when dividing an odd number in half)
      await modifyCrvBalance(token, tolerance + 1n, 1000n);
      await assertTriggerStatus(false);

      // Decrease balance by an amount more than tolerance, should be triggered
      await modifyCrvBalance(token, tolerance - 1n, 1000n);
      await assertTriggerStatus(true);
    });
  });
});
