// --- Imports ---
import { artifacts, ethers, network, waffle } from 'hardhat';
import { expect } from 'chai';
import type { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { MockCozyToken, IERC20, IRariVault, RariSharePrice } from '../typechain';

// --- Constants and extracted methods ---
const wad = 10n ** 18n;
const { deployContract, loadFixture } = waffle;
const { MaxUint256: MAX_UINT } = ethers.constants;
const { hexZeroPad } = ethers.utils;
const BN = (x: BigNumberish) => ethers.BigNumber.from(x);
const to32ByteHex = (x: BigNumberish) => hexZeroPad(BN(x).toHexString(), 32);

interface VaultInfo {
  name: string;
  market: string;
}

// Rari vaults
const markets: VaultInfo[] = [
  { name: 'Rari USDC Pool', market: '0xC6BF8C8A55f77686720E0a88e2Fd1fEEF58ddf4a' },
  { name: 'Rari DAI Pool', market: '0xB465BAF04C087Ce3ed1C266F96CA43f4847D9635' },
];

// --- Tests ---
markets.forEach((vault) => {
  describe(`Vault: ${vault.name}`, function () {
    // --- Data ---
    let market: IRariVault;
    let token: IERC20;
    let deployer: SignerWithAddress;
    let trigger: RariSharePrice;
    let triggerParams: (string | number[])[] = []; // trigger params deployment parameters

    // --- Functions modifying storage ---
    /**
     * @notice Change Rari vault's price per share by modifying total supply (since share price is a getter method that
     * divides by total token supply)
     * @param supply New total supply. To zero out share price, use MAX_UINT256, which simulates unlimited minting of
     * shares, making price per share effectively 0
     */
    async function setVaultTotalSupply(supply: BigNumberish) {
      const storageSlot = '0x35';
      await network.provider.send('hardhat_setStorageAt', [token.address, storageSlot, to32ByteHex(supply)]);
    }

    // --- Test fixture ---
    // Executes checkAndToggleTrigger and verifies the expected state
    async function assertTriggerStatus(status: boolean) {
      await trigger.checkAndToggleTrigger();
      expect(await trigger.isTriggered()).to.equal(status);
    }

    // Gets the effective share price of the vault
    async function getPricePerShare() {
      const balance = <BigNumber>await market.callStatic.getFundBalance();
      const supply = <BigNumber>await token.totalSupply();
      return balance.mul(wad).div(supply); // need to scale balance before division since both balance and supply are on the scale of 1e18
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
      const market = <IRariVault>await ethers.getContractAt('IRariVault', vault.market);
      const token = <IERC20>await ethers.getContractAt('IERC20', await market.rariFundToken());

      // Deploy trigger
      const triggerParams = [
        'Rari USDC Trigger', // name
        'rariUSDC-TRIG', // symbol
        'Triggers when the Rari USDC vault share price decreases by more than 50% between consecutive checks.', // description
        [10], // platform ID
        recipient.address, // subsidy recipient
        vault.market, // mainnet address
      ];

      const triggerArtifact = await artifacts.readArtifact('RariSharePrice');
      const trigger = <RariSharePrice>await deployContract(deployer, triggerArtifact, triggerParams);

      return { deployer, market, token, trigger, triggerParams };
    }

    // --- Tests ---
    beforeEach(async () => {
      ({ deployer, market, token, trigger, triggerParams } = await loadFixture(setupFixture));
    });

    it('USDC pool: share price only increases', async () => {
      // --- Helper variables and methods ---
      if (vault.name !== 'Rari USDC Pool') return;
      const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      const usdc = new ethers.Contract(usdcAddress, ['function approve(address,uint256) external'], deployer);

      const rariAbi = [
        'function deposit(string calldata currencyCode, uint256 amount) external',
        'function withdraw(string calldata currencyCode, uint256 amount) external returns (uint256)',
      ];
      const rari = new ethers.Contract(market.address, rariAbi, deployer);
      const rariToken = await ethers.getContractAt('IERC20', '0x016bf078ABcaCB987f0589a6d3BEAdD4316922B0', deployer);

      function getBalanceOfSlotSolidity(mappingSlot: string, address: string) {
        const { hexStripZeros, keccak256, defaultAbiCoder } = ethers.utils;
        return hexStripZeros(keccak256(defaultAbiCoder.encode(['address', 'uint256'], [address, mappingSlot])));
      }

      async function setUsdcBalance(account: string, amount: BigNumberish) {
        const slot = getBalanceOfSlotSolidity('0x9', account);
        await network.provider.send('hardhat_setStorageAt', [usdcAddress, slot, to32ByteHex(amount)]);
      }

      async function getPricePerShare() {
        await trigger.checkAndToggleTrigger();
        return trigger.lastPricePerShare();
      }

      async function getRariBalance() {
        return rariToken.balanceOf(deployer.address);
      }

      // --- Setup ---
      const sp1 = await getPricePerShare();
      const bal1 = await getRariBalance();

      // --- Give user USDC ---
      const amount = ethers.utils.parseUnits('1000000000', 6);
      await setUsdcBalance(deployer.address, amount);

      // --- Deposit ---
      await usdc.approve(rari.address, ethers.constants.MaxUint256);
      await rari.deposit('USDC', amount);
      const sp2 = await getPricePerShare();
      const bal2 = await getRariBalance();
      expect(sp2.gt(sp1)).to.be.true;
      expect(bal2.gt(bal1)).to.be.true;

      // --- Withdraw ---
      await rari.withdraw('USDC', amount);
      const sp3 = await getPricePerShare();
      const bal3 = await getRariBalance();
      expect(sp3.gt(sp2)).to.be.true;
      expect(bal3.lt(bal2)).to.be.true;

      // --- Log outputs for verification ---
      console.log('share price 1', sp1.toString());
      console.log('share price 2', sp2.toString());
      console.log('share price 3', sp3.toString());
      console.log('');
      console.log('rari receipt token balance 1', bal1.toString());
      console.log('rari receipt token balance 2', bal2.toString());
      console.log('rari receipt token balance 3', bal3.toString());
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

        await setVaultTotalSupply(MAX_UINT);
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

        // Break the vault
        await setVaultTotalSupply(MAX_UINT);
        await mockCozyToken.checkAndToggleTrigger();
        expect(await mockCozyToken.isTriggered()).to.be.true;
      });

      it('properly updates the saved state', async () => {
        // Update values
        await setVaultTotalSupply(10n ** 18n); // don't set them too high or trigger will toggle

        // Call checkAndToggleTrigger to simulate someone using the protocol
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.be.false; // sanity check
        const newPricePerShare = await getPricePerShare();

        // Verify the new state
        const currentPricePerShare = await trigger.lastPricePerShare();
        expect(currentPricePerShare.toString()).to.equal(newPricePerShare.toString()); // bigint checks are flaky with chai
      });

      it('properly accounts for price per share tolerance', async () => {
        // Modify the currently stored share price by a set tolerance. To increase share price by a tolerance, we
        // decrease total supply by that amount
        async function modifyLastPricePerShare(numerator: bigint, denominator: bigint) {
          const lastPricePerShare = (await trigger.lastPricePerShare()).toBigInt();
          const lastTotalSupply = (await token.totalSupply()).toBigInt();
          const newTotalSupply = (lastTotalSupply * denominator) / numerator;
          const newPricePerShare = (lastPricePerShare * numerator) / denominator;
          await setVaultTotalSupply(newTotalSupply);
          // Due to rounding error, values may sometimes differ by 1 wei, so validate with a tolerance +/2 wei
          expect(await getPricePerShare()).to.be.above(newPricePerShare - 2n);
          expect(await getPricePerShare()).to.be.below(newPricePerShare + 2n);
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
