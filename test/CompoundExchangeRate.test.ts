import { artifacts, ethers, waffle } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { MockCozyToken, MockCToken, CompoundExchangeRate } from '../typechain';

const { deployContract } = waffle;
const { formatBytes32String } = ethers.utils;

describe('CompoundExchangeRate', function () {
  let deployer: SignerWithAddress, recipient: SignerWithAddress;
  let mockCUsdc: MockCToken;
  let trigger: CompoundExchangeRate;
  let triggerParams: (string | number[])[] = []; // trigger params deployment parameters

  before(async () => {
    [deployer, recipient] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // Deploy Mock CToken
    const mockCTokenArtifact = await artifacts.readArtifact('MockCToken');
    mockCUsdc = <MockCToken>await deployContract(deployer, mockCTokenArtifact);

    // Deploy  CompoundExchangeRate trigger
    triggerParams = [
      'Compound Exchange Rate Trigger', // name
      'COMP-ER-TRIG', // symbol
      'Triggers when the Compound exchange rate decreases', // description
      [4], // platform ID for Compound
      recipient.address, // subsidy recipient
      mockCUsdc.address, // address of the Compound CToken market this trigger checks
    ];
    const compoundExchangeRateArtifact = await artifacts.readArtifact('CompoundExchangeRate');
    trigger = <CompoundExchangeRate>await deployContract(deployer, compoundExchangeRateArtifact, triggerParams);
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
      expect(await trigger.tolerance()).to.equal('10000');
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

      await mockCUsdc.set(formatBytes32String('exchangeRateStored'), 1);
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

      // Break the CToken
      await mockCUsdc.set(formatBytes32String('exchangeRateStored'), 1);
      await mockCozyToken.checkAndToggleTrigger();
      expect(await mockCozyToken.isTriggered()).to.be.true;
    });

    it('properly updates the saved state', async () => {
      // Get initial state
      const initialExchangeRate = (await trigger.lastExchangeRate()).toBigInt();

      // Update exchange rate
      const newExchangeRate = initialExchangeRate + 250n;
      await mockCUsdc.set(formatBytes32String('exchangeRateStored'), newExchangeRate);

      // Call checkAndToggleTrigger to simulate someone using the protocol
      await trigger.checkAndToggleTrigger();
      expect(await trigger.isTriggered()).to.be.false; // sanity check

      // Verify the new state
      const currentExchangeRate = await trigger.lastExchangeRate();
      expect(currentExchangeRate.toString()).to.equal(newExchangeRate.toString()); // bigint checks are flaky with chai
    });

    it('properly accounts for tolerance', async () => {
      // Modify the currently stored exchange rate by a set tolerance
      async function modifyLastExchangeRate(amount: bigint) {
        const lastExchangeRate = (await trigger.lastExchangeRate()).toBigInt();
        const newExchangeRate = lastExchangeRate + amount;
        await mockCUsdc.set(formatBytes32String('exchangeRateStored'), newExchangeRate);
        expect(await mockCUsdc.exchangeRateStored()).to.equal(newExchangeRate);
      }

      // Executes checkAndToggleTrigger and verifies the expected state
      async function assertTriggerStatus(status: boolean) {
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.equal(status);
      }

      // Read the trigger's tolerance
      const tolerance = (await trigger.tolerance()).toBigInt();

      // Increase exchange rate to a larger value, should NOT be triggered (sanity check)
      await modifyLastExchangeRate(100n);
      await assertTriggerStatus(false);

      // Decrease exchange rate by an amount less than tolerance, should NOT be triggered
      await modifyLastExchangeRate(tolerance - 1n);
      await assertTriggerStatus(false);

      // Decrease exchange rate by an amount exactly equal to tolerance, should NOT be triggered
      await modifyLastExchangeRate(-tolerance);
      await assertTriggerStatus(false);

      // Decrease exchange rate by an amount more than tolerance, should be triggered
      await modifyLastExchangeRate(-tolerance - 1n);
      await assertTriggerStatus(true);
    });
  });
});
