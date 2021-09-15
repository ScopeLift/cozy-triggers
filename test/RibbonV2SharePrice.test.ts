// --- Imports ---
import { artifacts, ethers, network, waffle } from 'hardhat';
import { expect } from 'chai';
import type { BigNumberish } from '@ethersproject/bignumber';
import { keccak256 } from '@ethersproject/keccak256';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { MockCozyToken, IRibbonVaultV2, RibbonV2SharePrice, IERC20 } from '../typechain';

// --- Constants and extracted methods ---
const { deployContract, loadFixture } = waffle;
const { MaxUint256: MAX_UINT } = ethers.constants;
const { defaultAbiCoder, hexZeroPad, hexStripZeros } = ethers.utils;
const BN = (x: BigNumberish) => ethers.BigNumber.from(x);
const to32ByteHex = (x: BigNumberish) => hexZeroPad(BN(x).toHexString(), 32);

interface VaultInfo {
  name: string;
  ribbonVault: string;
}

// Ribbon vault pairings to test
const vaults: VaultInfo[] = [
  {
    name: 'T-ETH-C',
    ribbonVault: '0x25751853Eab4D0eB3652B5eB6ecB102A2789644B',
  },
];

// --- Storage slot helper methods ---
// `defaultAbiCoder.encode` is equivalent to Solidity's `abi.encode()`, and we strip leading zeros from the hashed
// value to conform to the JSON-RPC spec: https://ethereum.org/en/developers/docs/apis/json-rpc/#hex-value-encoding

// Returns the storage slot for a Solidity mapping from an `address` to a value, given the slot of the mapping itself,
//  `mappingSlot`. Read more at https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#mappings-and-dynamic-arrays
const getSolidityStorageSlot = (mappingSlot: string, address: string) => {
  return hexStripZeros(keccak256(defaultAbiCoder.encode(['address', 'uint256'], [address, mappingSlot])));
};

// Returns the storage slot for a Vyper mapping from an `address` to a value, given the slot of the mapping itself,
//  `mappingSlot`. May be dependent on the Vyper version used. See this tweet thread for more info: https://twitter.com/msolomon44/status/1420137730009300992
const getVyperStorageSlot = (mappingSlot: string, address: string) => {
  return hexStripZeros(keccak256(defaultAbiCoder.encode(['uint256', 'address'], [mappingSlot, address])));
};

// --- Tests ---
vaults.forEach((vault) => {
  describe(`Ribbon Vault: ${vault.name}`, function () {
    // --- Data ---
    let ribbonVault: IRibbonVaultV2;
    let deployer: SignerWithAddress;
    let trigger: RibbonV2SharePrice;
    let triggerParams: (string | number[])[] = []; // trigger params deployment parameters

    // --- Functions modifying storage ---
    /**
     * @notice Change Ribbon vault's price per share by modifying total supply (since share price is a getter method that
     * divides by total token supply)
     * @param supply New total supply. To zero out share price, use MAX_UINT256, which simulates unlimited minting of
     * shares, making price per share effectively 0
     */
    async function setRibbonTotalSupply(supply: BigNumberish) {
      const storageSlot = '0x99'; // storage slot 153 in Ribbon vault contains total supply (lots of gap due to OpenZeppelin's implementation)
      await network.provider.send('hardhat_setStorageAt', [vault.ribbonVault, storageSlot, to32ByteHex(supply)]);
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
      const ribbonVault = <IRibbonVaultV2>await ethers.getContractAt('IRibbonVaultV2', vault.ribbonVault);

      // Deploy RibbonV2SharePrice trigger
      const triggerParams = [
        'Ribbon T-ETH-C Trigger', // name
        'RibbonT-ETH-C-TRIG', // symbol
        'Triggers when the Ribbon Theta Vault ETH pool virtual price decreases by more than 50% between consecutive checks', // description
        [9], // platform ID for ribbon
        recipient.address, // subsidy recipient
        vault.ribbonVault, // mainnet ribbon vault
      ];

      const RibbonV2SharePriceArtifact = await artifacts.readArtifact('RibbonV2SharePrice');
      const trigger = <RibbonV2SharePrice>await deployContract(deployer, RibbonV2SharePriceArtifact, triggerParams);

      return { deployer, ribbonVault, trigger, triggerParams };
    }

    // --- Tests ---
    beforeEach(async () => {
      ({ deployer, ribbonVault, trigger, triggerParams } = await loadFixture(setupFixture));
    });

    describe('Deployment', () => {
      it('initializes properly', async () => {
        expect(await trigger.name()).to.equal(triggerParams[0]);
        expect(await trigger.symbol()).to.equal(triggerParams[1]);
        expect(await trigger.description()).to.equal(triggerParams[2]);
        const platformIds = (await trigger.getPlatformIds()).map((id) => id.toNumber());
        expect(platformIds).to.deep.equal(triggerParams[3]); // use `.deep.equal` to compare array equality
        expect(await trigger.recipient()).to.equal(triggerParams[4]);
        expect(await trigger.market()).to.equal(triggerParams[5]);
        expect(await trigger.tolerance()).to.equal('500');
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

        await setRibbonTotalSupply(MAX_UINT);
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

        // Break the Ribbon vault
        await setRibbonTotalSupply(MAX_UINT);
        await mockCozyToken.checkAndToggleTrigger();
        expect(await mockCozyToken.isTriggered()).to.be.true;
      });

      it('properly updates the saved state', async () => {
        // Update values
        await setRibbonTotalSupply(10n ** 18n); // don't set them too high or trigger will toggle

        // Call checkAndToggleTrigger to simulate someone using the protocol
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.be.false; // sanity check
        const newPricePerShare = await ribbonVault.pricePerShare();

        // Verify the new state
        const currentPricePerShare = await trigger.lastPricePerShare();
        expect(currentPricePerShare.toString()).to.equal(newPricePerShare.toString()); // bigint checks are flaky with chai
      });

      it('properly accounts for price per share tolerance', async () => {
        // Modify the currently stored share price by a set tolerance. To increase share price by a tolerance, we
        // decrease total supply by that amount
        async function modifyLastPricePerShare(numerator: bigint, denominator: bigint) {
          const lastPricePerShare = (await trigger.lastPricePerShare()).toBigInt();
          const lastTotalSupply = (await ribbonVault.totalSupply()).toBigInt();
          const newTotalSupply = (lastTotalSupply * denominator) / numerator;
          const newPricePerShare = (lastPricePerShare * numerator) / denominator;
          await setRibbonTotalSupply(newTotalSupply);
          // Due to rounding error, values may sometimes differ by 1 wei, so validate with a tolerance +/2 wei
          expect(await ribbonVault.pricePerShare()).to.be.above(newPricePerShare - 2n);
          expect(await ribbonVault.pricePerShare()).to.be.below(newPricePerShare + 2n);
        }

        // Read the trigger's tolerance
        const tolerance = (await trigger.tolerance()).toBigInt();

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
    });
  });
});
