/**
 * @notice This file tests the MockTrigger.sol contract included in this repository, and contains an initial set
 * of tests that should be modified and tested for any real trigger
 * @dev The default configuration of this repository means these tests will run against a forked network, with
 * the network it runs against being defined in the RPC_URL environment variable
 */

import { artifacts, ethers, waffle } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { MockCozyToken, MockTrigger } from '../typechain';
const { deployContract } = waffle;

describe('MockTrigger', function () {
  let deployer: SignerWithAddress, recipient: SignerWithAddress;
  let trigger: MockTrigger;
  let triggerParams: any[] = []; // trigger params deployment parameters

  before(async () => {
    [deployer, recipient] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // Deploy  MockTrigger contract
    triggerParams = [
      'Mock Trigger', // name
      'MOCK-TRIG', // symbol
      'A mock trigger that anyone can toggle', // description
      [3], // array of platform IDs that this trigger protects
      recipient.address, // subsidy recipient
      false, // mock trigger should not be toggled initially
    ];
    const mockTriggerArtifact = await artifacts.readArtifact('MockTrigger');
    trigger = <MockTrigger>await deployContract(deployer, mockTriggerArtifact, triggerParams);
  });

  describe('Deployment', () => {
    it('initializes properly', async () => {
      expect(await trigger.name()).to.equal(triggerParams[0]);
      expect(await trigger.symbol()).to.equal(triggerParams[1]);
      expect(await trigger.description()).to.equal(triggerParams[2]);
      const platformIds = (await trigger.getPlatformIds()).map((id) => id.toNumber());
      expect(platformIds).to.deep.equal(triggerParams[3]); // use `.deep.equal` to compare array equality
      expect(await trigger.recipient()).to.equal(triggerParams[4]);
      expect(await trigger.shouldToggle()).to.equal(triggerParams[5]);
    });

    it('should not deploy if market is already triggered', async () => {
      // Update triggerParams so initial value of `shouldToggle` is true
      const newParams = [...triggerParams.slice(0, triggerParams.length - 1), true];

      // Try deploying the trigger
      const mockTriggerArtifact = await artifacts.readArtifact('MockTrigger');
      await expect(deployContract(deployer, mockTriggerArtifact, newParams)).to.be.revertedWith('Already triggered');
    });
  });

  describe('checkAndToggleTrigger', () => {
    it('does nothing when it should do nothing', async () => {
      expect(await trigger.isTriggered()).to.be.false;
      await trigger.checkAndToggleTrigger();
      expect(await trigger.isTriggered()).to.be.false;
    });

    it('toggles trigger when expected to toggle trigger', async () => {
      // Trigger should be false initially
      expect(await trigger.isTriggered()).to.be.false;

      // Set the trigger so that it should toggle on the next check
      await trigger.setShouldToggle(true);
      expect(await trigger.isTriggered()).to.be.false; // trigger not updated yet, so we still expect false

      // Call `checkAndToggleTrigger()` and verify result
      const tx = await trigger.checkAndToggleTrigger();
      await expect(tx).to.emit(trigger, 'TriggerActivated');
      expect(await trigger.isTriggered()).to.be.true;
    });

    it('returns a boolean with the value of isTriggered', async () => {
      // Deploy our helper contract for testing, which has a state variable called `isTriggered` that stores the last
      // value returned from `trigger.checkAndToggleTrigger()`
      const mockCozyTokenArtifact = await artifacts.readArtifact('MockCozyToken');
      const mockCozyToken = <MockCozyToken>await deployContract(deployer, mockCozyTokenArtifact, [trigger.address]);
      expect(await mockCozyToken.isTriggered()).to.be.false;

      // Toggle the trigger, and the mock Cozy Token should have it's state updated
      await trigger.setShouldToggle(true);
      await mockCozyToken.checkAndToggleTrigger();
      expect(await mockCozyToken.isTriggered()).to.be.true;
    });
  });
});
