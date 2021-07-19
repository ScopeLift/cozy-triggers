import { artifacts, ethers, network, waffle } from 'hardhat';
import type { BigNumber } from '@ethersproject/bignumber';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { MockCozyToken, IYVaultV2, ICrvTricrypto, YearnCrvTricrypto } from '../typechain';

const { deployContract, loadFixture } = waffle;
const { MaxUint256 } = ethers.constants;
const yearnVaultAddress = '0x3D980E50508CFd41a13837A60149927a11c03731'; // mainnet Yearn crvTricrypto vault
const curveTricryptoAddress = '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46'; // mainnet Curve Tricrypto pool

describe('YearnCrvTricrypto', function () {
  let yCrvTricrypto: IYVaultV2;
  let crvTricrypto: ICrvTricrypto;
  let deployer: SignerWithAddress;
  let trigger: YearnCrvTricrypto;
  let triggerParams: (string | number[])[] = []; // trigger params deployment parameters

  /**
   * @notice Change Yearn vault's price per share by modifying total supply (since share price is a getter method that
   * divides by total token supply)
   * @param supply New total supply. To zero out share price, use MAX_UINT256, which simulates unlimited minting of
   * shares, making price per share effectively 0
   */
  async function setYearnTotalSupply(supply: BigNumber) {
    const storageSlot = '0x5'; // storage slot 5 in Yearn vault contains total supply
    await network.provider.send('hardhat_setStorageAt', [yearnVaultAddress, storageSlot, supply.toHexString()]);
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
    const yCrvTricrypto = <IYVaultV2>await ethers.getContractAt('IYVaultV2', yearnVaultAddress);
    const crvTricrypto = <ICrvTricrypto>await ethers.getContractAt('ICrvTricrypto', curveTricryptoAddress);

    // Deploy YearnCrvTricrypto trigger
    const triggerParams = [
      'Yearn Curve Tricrypto Trigger', // name
      'yCRV-TRICRYPTO-TRIG', // symbol
      'Triggers when the Yearn vault share price decreases, or the tricrypto pool fails', // description
      [1, 3], // platform IDs for Yearn and Curve, respectively
      recipient.address, // subsidy recipient
      yearnVaultAddress, // mainnet Yearn crvTricrypto vault
      curveTricryptoAddress, // mainnet Curve Tricrypto pool
    ];

    const YearnCrvTricryptoArtifact = await artifacts.readArtifact('YearnCrvTricrypto');
    const trigger = <YearnCrvTricrypto>await deployContract(deployer, YearnCrvTricryptoArtifact, triggerParams);

    return { deployer, yCrvTricrypto, crvTricrypto, trigger, triggerParams };
  }

  beforeEach(async () => {
    ({ deployer, yCrvTricrypto, crvTricrypto, trigger, triggerParams } = await loadFixture(setupFixture));
  });

  describe('Deployment', () => {
    it('initializes properly', async () => {
      expect(await trigger.name()).to.equal(triggerParams[0]);
      expect(await trigger.symbol()).to.equal(triggerParams[1]);
      expect(await trigger.description()).to.equal(triggerParams[2]);
      const platformIds = (await trigger.getPlatformIds()).map((id) => id.toNumber());
      expect(platformIds).to.deep.equal(triggerParams[3]); // use `.deep.equal` to compare array equality
      expect(await trigger.recipient()).to.equal(triggerParams[4]);
      expect(await trigger.vault()).to.equal(triggerParams[5]);
      expect(await trigger.curve()).to.equal(triggerParams[6]);
      expect(await trigger.vaultTol()).to.equal('500');
      expect(await trigger.virtualPriceTol()).to.equal('490');
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

      await setYearnTotalSupply(MaxUint256);
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
      await setYearnTotalSupply(MaxUint256);
      await mockCozyToken.checkAndToggleTrigger();
      expect(await mockCozyToken.isTriggered()).to.be.true;
    });

    it('properly updates the saved state', async () => {
      // Get initial state
      const initialPricePerShare = (await trigger.lastPricePerShare()).toBigInt();
      const initialVirtualPrice = (await trigger.lastVirtualPrice()).toBigInt();

      // Update values
      const newPricePerShare = initialPricePerShare + 250n;
      await yCrvTricrypto.set(newPricePerShare);
      const newVirtualPrice = initialVirtualPrice + 123n;
      await crvTricrypto.set(newVirtualPrice);

      // Call checkAndToggleTrigger to simulate someone using the protocol
      await trigger.checkAndToggleTrigger();
      expect(await trigger.isTriggered()).to.be.false; // sanity check

      // Verify the new state
      const currentPricePerShare = await trigger.lastPricePerShare();
      expect(currentPricePerShare.toString()).to.equal(newPricePerShare.toString()); // bigint checks are flaky with chai
      const currentVirtualPrice = await trigger.lastVirtualPrice();
      expect(currentVirtualPrice.toString()).to.equal(newVirtualPrice.toString());
    });

    it('properly accounts for price per share tolerance', async () => {
      // Modify the currently stored share price by a set tolerance
      async function modifyLastPricePerShare(numerator: bigint, denominator: bigint) {
        const lastPricePerShare = (await trigger.lastPricePerShare()).toBigInt();
        const newPricePerShare = (lastPricePerShare * numerator) / denominator;
        await yCrvTricrypto.set(newPricePerShare);
        expect(await yCrvTricrypto.pricePerShare()).to.equal(newPricePerShare);
      }

      // Executes checkAndToggleTrigger and verifies the expected state
      async function assertTriggerStatus(status: boolean) {
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.equal(status);
      }

      // Read the trigger's tolerance (which is stored as percentage with 18 decimals such that 1e18 = 100%)
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
        const newVirtualPrice = (lastVirtualPrice * numerator) / denominator;
        await crvTricrypto.set(newVirtualPrice);
        expect(await crvTricrypto.get_virtual_price()).to.equal(newVirtualPrice);
      }

      // Executes checkAndToggleTrigger and verifies the expected state
      async function assertTriggerStatus(status: boolean) {
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.equal(status);
      }

      // Read the trigger's tolerance (which is stored as percentage with 18 decimals such that 1e18 = 100%)
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
  });
});
