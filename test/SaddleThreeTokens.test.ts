// --- Imports ---
import { artifacts, ethers, network, waffle } from 'hardhat';
import { expect } from 'chai';
import type { BigNumberish } from '@ethersproject/bignumber';
import { keccak256 } from '@ethersproject/keccak256';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { MockCozyToken, ISaddlePool, YearnCrvTwoTokens, IERC20 } from '../typechain';

// --- Constants and extracted methods ---
const { deployContract, loadFixture } = waffle;
const { MaxUint256: MAX_UINT } = ethers.constants;
const { defaultAbiCoder, hexZeroPad, hexStripZeros } = ethers.utils;
const BN = (x: BigNumberish) => ethers.BigNumber.from(x);
const to32ByteHex = (x: BigNumberish) => hexZeroPad(BN(x).toHexString(), 32);

// Mainnet token addresses
const tokenAddresses = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  alETH: '0x0100546F2cD4C9D97f798fFC9755E47865FF7Ee6',
  sETH: '0x34a5ef81d18f3a305ae9c2d7df42beef4c79031c', // actual address is a proxy at 0x5e74C9036fb86BD7eCdcb084a0673EFc32eA31cb', but here we point to `tokenState` contract
};

// Define methods needed to calculate balanceOf storage slots for each token
const balanceOfSlots = {
  WETH: (address: string) => getSolidityStorageSlot('0x3', address),
  alETH: (address: string) => getSolidityStorageSlot('0x1', address),
  sETH: (address: string) => getSolidityStorageSlot('0x3', address),
};

type SaddleUnderlying = keyof typeof tokenAddresses;
interface Pool {
  name: string;
  saddlePool: string;
  saddleToken: string;
  saddlePoolTokens: SaddleUnderlying[];
}

// Saddle Pools
const pools: Pool[] = [
  {
    name: 'Saddle alETH Pool',
    saddlePool: '0xa6018520EAACC06C30fF2e1B3ee2c7c22e64196a',
    saddleToken: '0xc9da65931ABf0Ed1b74Ce5ad8c041C4220940368',
    saddlePoolTokens: ['WETH', 'alETH', 'sETH'],
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

// --- Generic helper methods ---
// Gets token balance
async function balanceOf(token: SaddleUnderlying, address: string): Promise<bigint> {
  const tokenAddress = tokenAddresses[token];
  if (!tokenAddress) throw new Error('Invalid token selection');
  const abi = ['function balanceOf(address) external view returns (uint256)'];
  const contract = new ethers.Contract(tokenAddress, abi, ethers.provider);
  return (await contract.balanceOf(address)).toBigInt();
}

// --- Tests ---
pools.forEach((pool) => {
  describe(`Saddle Pool: ${pool.name}`, function () {
    // --- Data ---
    let saddlePool: ISaddlePool;
    let saddleToken: IERC20;
    let deployer: SignerWithAddress;
    let trigger: YearnCrvTwoTokens;
    let triggerParams: (string | number[])[] = []; // trigger params deployment parameters

    // --- Functions modifying storage ---
    /**
     * @notice Change Saddle pool's virtual price by modifying total supply (since virtual price is a getter method that
     * divides by total token supply)
     * @param supply New total supply. To zero out share price, use MAX_UINT256, which simulates unlimited minting of
     * shares, making price per share effectively 0
     */
    async function setSaddleTotalSupply(supply: BigNumberish) {
      const storageSlot = '0x35'; // storage slot 53 (0x35) is Saddle token total supply (starts late due to OpenZeppelin storage gap: https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps)
      await network.provider.send('hardhat_setStorageAt', [pool.saddleToken, storageSlot, to32ByteHex(supply)]);
    }

    /**
     * @notice Modify the balance of a token in the Saddle pool
     * @param token Token symbol
     * @param balance New balance to set
     */
    async function modifySaddleBalance(token: SaddleUnderlying, numerator: bigint, denominator: bigint) {
      const value = ((await balanceOf(token, pool.saddlePool)) * numerator) / denominator;
      const tokenAddress = tokenAddresses[token];
      if (!tokenAddress) throw new Error('Invalid token selection');
      const storageSlot = balanceOfSlots[token](pool.saddlePool);
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
      const saddlePool = <ISaddlePool>await ethers.getContractAt('ISaddlePool', pool.saddlePool);
      const saddleToken = <IERC20>await ethers.getContractAt('IERC20', pool.saddleToken);

      // Deploy SaddleThreeTokens trigger
      const triggerParams = [
        'Saddle alETH Trigger', // name
        'saddlealETH-TRIG', // symbol
        "Triggers when the Saddle alETH pool virtual price decreases by more than 50% between consecutive checks, or when the internal balances tracked in the Saddle alETH pool are more than 50% lower than the true balances", // prettier-ignore
        [7], // platform IDs for Yearn and Saddle, respectively
        recipient.address, // subsidy recipient
        pool.saddlePool, // mainnet Saddle Tricrypto pool
      ];

      const saddleThreeTokensArtifact = await artifacts.readArtifact('SaddleThreeTokens');
      const trigger = <YearnCrvTwoTokens>await deployContract(deployer, saddleThreeTokensArtifact, triggerParams);

      return { deployer, saddlePool, saddleToken, trigger, triggerParams };
    }

    // --- Tests ---
    beforeEach(async () => {
      ({ deployer, saddlePool, saddleToken, trigger, triggerParams } = await loadFixture(setupFixture));
    });

    describe('Deployment', () => {
      it('initializes properly', async () => {
        expect(await trigger.name()).to.equal(triggerParams[0]);
        expect(await trigger.symbol()).to.equal(triggerParams[1]);
        expect(await trigger.description()).to.equal(triggerParams[2]);
        const platformIds = (await trigger.getPlatformIds()).map((id) => id.toNumber());
        expect(platformIds).to.deep.equal(triggerParams[3]); // use `.deep.equal` to compare array equality
        expect(await trigger.recipient()).to.equal(triggerParams[4]);
        expect(await trigger.saddle()).to.equal(triggerParams[5]);
        expect(await trigger.virtualPriceTol()).to.equal('500');
        expect(await trigger.balanceTol()).to.equal('500');
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

        await modifySaddleBalance('WETH', 1n, 1000n);
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
        await modifySaddleBalance('WETH', 1n, 1000n);
        await mockCozyToken.checkAndToggleTrigger();
        expect(await mockCozyToken.isTriggered()).to.be.true;
      });

      it('properly updates the saved state', async () => {
        // Update values
        await setSaddleTotalSupply(10n ** 18n);

        // Call checkAndToggleTrigger to simulate someone using the protocol
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.be.false; // sanity check
        const newVirtualPrice = await saddlePool.getVirtualPrice();

        // Verify the new state
        const currentVirtualPrice = await trigger.lastVirtualPrice();
        expect(currentVirtualPrice.toString()).to.equal(newVirtualPrice.toString());
      });

      it('properly accounts for virtual price tolerance', async () => {
        // Modify the currently stored virtual price by a set tolerance
        async function modifyLastVirtualPrice(numerator: bigint, denominator: bigint) {
          const lastVirtualPrice = (await trigger.lastVirtualPrice()).toBigInt();
          const lastTotalSupply = (await saddleToken.totalSupply()).toBigInt();
          const newTotalSupply = (lastTotalSupply * denominator) / numerator;
          const newVirtualPrice = (lastVirtualPrice * numerator) / denominator;
          await setSaddleTotalSupply(newTotalSupply);
          // Due to rounding error, values may sometimes differ by 1 wei, so validate with a tolerance +/2 wei
          expect(await saddlePool.getVirtualPrice()).to.be.above(newVirtualPrice - 2n);
          expect(await saddlePool.getVirtualPrice()).to.be.below(newVirtualPrice + 2n);
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

      pool.saddlePoolTokens.forEach((tokenSymbol) => {
        it(`properly accounts for ${tokenSymbol.toUpperCase()} balance being drained`, async () => {
          const tolerance = (await trigger.balanceTol()).toBigInt();

          // Increase balance to a larger value, should NOT be triggered (sanity check)
          await modifySaddleBalance(tokenSymbol, 101n, 100n); // 1% increase
          await assertTriggerStatus(false);

          // Decrease balance by an amount less than tolerance, should NOT be triggered
          await modifySaddleBalance(tokenSymbol, 99n, 100n); // 1% decrease
          await assertTriggerStatus(false);

          // Decrease balance by an amount exactly equal to tolerance, should NOT be triggered
          // We add 1 to tolerance to prevent triggering here if balance is an odd number. For example if
          // balance = 11, this will set the balance to 11 // 2 = 5, which will trigger because it's below 5.5
          await modifySaddleBalance(tokenSymbol, tolerance + 1n, 1000n);
          await assertTriggerStatus(false);

          // Decrease balance by an amount more than tolerance, should be triggered
          await modifySaddleBalance(tokenSymbol, tolerance - 1n, 1000n);
          await assertTriggerStatus(true);
        });
      });
    });
  });
});
