// --- Imports ---
import hre, { artifacts, ethers, network, waffle } from 'hardhat';
import { expect } from 'chai';
import type { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { keccak256 } from '@ethersproject/keccak256';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { MockCozyToken, ICurvePool, IERC20, CurveThreeTokenBasePool } from '../../typechain';
import { reset } from '../../utils/utils';

export interface Addresses {
  curve: {
    curve3CryptoAddress: string;
    curveTokenAddress: string;
  };
  tokens: {
    usdt: string;
    wbtc: string;
    weth: string;
  };
}

export interface Slots {
  tokensBalanceOf: {
    usdt: string;
    wbtc: string;
    weth: string;
  };
  curveTokenTotalSupply: string;
}

export const genericCurveThreeTokenBasePoolTests = (addresses: Addresses, slots: Slots) => {
  // --- Constants and extracted methods ---
  const { deployContract, loadFixture } = waffle;
  const { MaxUint256: MAX_UINT } = ethers.constants;
  const { defaultAbiCoder, hexZeroPad, hexStripZeros } = ethers.utils;
  const BN = (x: BigNumberish) => ethers.BigNumber.from(x);
  const to32ByteHex = (x: BigNumberish) => hexZeroPad(BN(x).toHexString(), 32);

  // Addresses on the chain forked by hardhat
  const curveAddresses = addresses.curve;
  const tokenAddresses = addresses.tokens;

  // Token balanceOf slots on the chain forked by hardhat
  const tokenBalanceOfSlots = slots.tokensBalanceOf;
  // totalSupply slot for Curve token on the chain forked by hardhat
  const curveTokenTotalSupplySlot = slots.curveTokenTotalSupply;

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

  describe(`Curve3Crypto`, function () {
    // --- Data ---
    let crv3Crypto: ICurvePool;
    let crvToken: IERC20;
    let deployer: SignerWithAddress;
    let trigger: CurveThreeTokenBasePool;
    let triggerParams: (string | number[])[] = []; // trigger params deployment parameters

    // --- Functions modifying storage ---

    /**
     * @notice Change Curve pool's virtual price by modifying total supply (since virtual price is a getter method that
     * divides by total token supply)
     * @param supply New total supply. To zero out share price, use MAX_UINT256, which simulates unlimited minting of
     * shares, making price per share effectively 0
     */
    async function setCrvTotalSupply(supply: BigNumberish) {
      await network.provider.send('hardhat_setStorageAt', [
        curveAddresses.curveTokenAddress,
        curveTokenTotalSupplySlot,
        to32ByteHex(supply),
      ]);
    }

    /**
     * @notice Modify the balance of a token in the Curve pool
     * @param token Token symbol
     * @param balance New balance to set
     */
    async function modifyCrvBalance(token: keyof typeof tokenBalanceOfSlots, numerator: bigint, denominator: bigint) {
      const value = ((await balanceOf(token, curveAddresses.curve3CryptoAddress)) * numerator) / denominator;
      const tokenAddress = tokenAddresses[token];
      if (!tokenAddress) throw new Error('Invalid token selection');
      const mappingSlot = tokenBalanceOfSlots[token];
      const storageSlot = getStorageSlot(mappingSlot, curveAddresses.curve3CryptoAddress);
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
      const crv3Crypto = <ICurvePool>await ethers.getContractAt('ICurvePool', curveAddresses.curve3CryptoAddress);
      const crvToken = <IERC20>await ethers.getContractAt('IERC20', curveAddresses.curveTokenAddress);

      // Deploy Curve 3Crypto trigger
      const triggerParams = [
        'Curve 3Crypto Trigger', // name
        'CRV-3CRYPTO-TRIG', // symbol
        "Triggers when the Curve 3Crypto pool's virtual price decreases by more than 50% between consecutive checks, or the internal balances tracked in the Curve 3Crypto pool are more than 50% lower than the true balances", // description
        [3], // platform ID for Curve
        recipient.address, // subsidy recipient
        curveAddresses.curve3CryptoAddress, // mainnet Curve 3Crypto pool
      ];

      const CurveThreeTokenBasePoolArtifact = await artifacts.readArtifact('CurveThreeTokenBasePool');
      const trigger = <CurveThreeTokenBasePool>(
        await deployContract(deployer, CurveThreeTokenBasePoolArtifact, triggerParams)
      );

      return { deployer, crv3Crypto, crvToken, trigger, triggerParams };
    }

    // --- Tests ---
    before(async () => {
      // Ensure mainnet is re-forked before test execution for each protection market to ensure storage slot state isolation
      await reset();
    });

    beforeEach(async () => {
      ({ deployer, crv3Crypto, crvToken, trigger, triggerParams } = await loadFixture(setupFixture));
    });

    describe('Deployment', () => {
      it('initializes properly', async () => {
        expect(await trigger.name()).to.equal(triggerParams[0]);
        expect(await trigger.symbol()).to.equal(triggerParams[1]);
        expect(await trigger.description()).to.equal(triggerParams[2]);
        const platformIds = (await trigger.getPlatformIds()).map((id: BigNumber) => id.toNumber());
        expect(platformIds).to.deep.equal(triggerParams[3]); // use `.deep.equal` to compare array equality
        expect(await trigger.recipient()).to.equal(triggerParams[4]);
        expect(await trigger.curve()).to.equal(triggerParams[5]);
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

        await setCrvTotalSupply(MAX_UINT);
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

        // Break the Curve pool
        await setCrvTotalSupply(MAX_UINT);
        await mockCozyToken.checkAndToggleTrigger();
        expect(await mockCozyToken.isTriggered()).to.be.true;
      });

      it('properly updates the saved state', async () => {
        // Update values
        await setCrvTotalSupply(10n ** 18n);

        // Call checkAndToggleTrigger to simulate someone using the protocol
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.be.false; // sanity check
        const newVirtualPrice = await crv3Crypto.get_virtual_price();

        // Verify the new state
        const currentVirtualPrice = await trigger.lastVirtualPrice();
        expect(currentVirtualPrice.toString()).to.equal(newVirtualPrice.toString()); // bigint checks are flaky with chai
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
};
