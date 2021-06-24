import { artifacts, ethers, waffle } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { MockCozyToken, MockYVaultV2, YearnV2SharePrice } from '../typechain';

const { deployContract } = waffle;
const { parseUnits } = ethers.utils;

describe('YearnV2SharePrice', function () {
  let deployer: SignerWithAddress, recipient: SignerWithAddress;
  let mockYUsdc: MockYVaultV2;
  let trigger: YearnV2SharePrice;
  let triggerParams: (string | number[])[] = []; // trigger params deployment parameters

  before(async () => {
    [deployer, recipient] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // Deploy Mock yVault
    const mockYVaultY2Artifact = await artifacts.readArtifact('MockYVaultV2');
    mockYUsdc = <MockYVaultV2>await deployContract(deployer, mockYVaultY2Artifact);

    // Deploy YearnV2SharePrice trigger
    triggerParams = [
      'Yearn USDC V2 Vault Share Price Trigger', // name
      'yUSDC-V2-SP-TRIG', // symbol
      'Triggers when the Yearn USDC V2 vault share price decreases', // description
      [1], // platform ID for Yearn
      recipient.address, // TODO set subsidy recipient
      mockYUsdc.address, // TODO set address of the yVault market this trigger checks
    ];

    const YearnV2SharePriceArtifact = await artifacts.readArtifact('YearnV2SharePrice');
    trigger = <YearnV2SharePrice>await deployContract(deployer, YearnV2SharePriceArtifact, triggerParams);
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
      expect(await trigger.tolerance()).to.equal(parseUnits('0.5', 18));
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

      await mockYUsdc.set(1);
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
      await mockYUsdc.set(1);
      await mockCozyToken.checkAndToggleTrigger();
      expect(await mockCozyToken.isTriggered()).to.be.true;
    });

    it('properly updates the saved state', async () => {
      // Get initial state
      const initialPricePerShare = (await trigger.lastPricePerShare()).toBigInt();

      // Update share price
      const newPricePerShare = initialPricePerShare + 250n;
      await mockYUsdc.set(newPricePerShare);

      // Call checkAndToggleTrigger to simulate someone using the protocol
      await trigger.checkAndToggleTrigger();
      expect(await trigger.isTriggered()).to.be.false; // sanity check

      // Verify the new state
      const currentPricePerShare = await trigger.lastPricePerShare();
      expect(currentPricePerShare.toString()).to.equal(newPricePerShare.toString()); // bigint checks are flaky with chai
    });

    it('properly accounts for tolerance', async () => {
      // Modify the currently stored share price by a set tolerance
      async function modifyLastPricePerShare(numerator: bigint, denominator: bigint) {
        const lastPricePerShare = (await trigger.lastPricePerShare()).toBigInt();
        const newPricePerShare = (lastPricePerShare * numerator) / denominator;
        await mockYUsdc.set(newPricePerShare);
        expect(await mockYUsdc.pricePerShare()).to.equal(newPricePerShare);
      }

      // Executes checkAndToggleTrigger and verifies the expected state
      async function assertTriggerStatus(status: boolean) {
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.equal(status);
      }

      // Read the trigger's tolerance (which is stored as percentage with 18 decimals such that 1e18 = 100%)
      const tolerance = (await trigger.tolerance()).toBigInt();

      // Increase share price to a larger value, should NOT be triggered (sanity check)
      await modifyLastPricePerShare(101n, 100n); // 1% increase
      await assertTriggerStatus(false);

      // Decrease share price by an amount less than tolerance, should NOT be triggered
      await modifyLastPricePerShare(99n, 100n); // 1% decrease
      await assertTriggerStatus(false);

      // Decrease share price by an amount exactly equal to tolerance, should NOT be triggered
      await modifyLastPricePerShare(tolerance, 10n ** 18n);
      await assertTriggerStatus(false);

      // Decrease share price by an amount more than tolerance, should be triggered
      await modifyLastPricePerShare(tolerance - 1n, 10n ** 18n);
      await assertTriggerStatus(true);
    });
  });
});
