// --- Imports ---
import { artifacts, ethers, network, waffle } from 'hardhat';
import { expect } from 'chai';
import type { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { Contract } from '@ethersproject/contracts';
import { keccak256 } from '@ethersproject/keccak256';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { smock } from '@defi-wonderland/smock';
import { reset } from '../../utils/utils';
import { IConvexBooster, MockCozyToken } from '../../typechain';

// --- Constants and extracted methods ---
const { deployContract, loadFixture } = waffle;
const { MaxUint256: MAX_UINT } = ethers.constants;
const { defaultAbiCoder, getAddress, hexZeroPad, hexStripZeros } = ethers.utils;
const BN = (x: BigNumberish) => ethers.BigNumber.from(x);
const to32ByteHex = (x: BigNumberish) => hexZeroPad(BN(x).toHexString(), 32);

// Mainnet token addresses
const convexAddress = '0xF403C135812408BFbE8713b5A23a04b3D48AAE31'; // Convex deposit contract (booster)
const recipient = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';

const pools = [
  {
    symbol: 'USDP', // used to generate interface names
    contract: 'ConvexUSDP',
    coinIndices: [0, 1, 2, 3, 4],
    metaIndices: [0, 1], // all other indices are the base pool
    poolId: 28, // convex pool ID
    triggerParams: [
      'Convex Curve USDP', // name
      'convexCurve-USDP-TRIG', // symbol
      'Convex Curve USDP trigger....', // description
      [3, 12], // platform IDs for Curve and Convex, respectively
      recipient, // subsidy recipient
      28, // convex pool ID
    ],
  },
  {
    symbol: 'tBTC',
    contract: 'ConvexTBTC',
    coinIndices: [0, 1, 2, 3, 4],
    metaIndices: [0, 1],
    poolId: 16,
    triggerParams: [
      'Convex Curve tBTC Trigger',
      'convexCurve-tBTC-TRIG',
      'Convex Curve tBTC trigger....',
      [3, 12],
      recipient,
      16,
    ],
  },
  {
    symbol: 'FRAX',
    contract: 'Convex2',
    coinIndices: [0, 1, 2, 3, 4],
    metaIndices: [0, 1],
    poolId: 32,
    triggerParams: [
      'Convex Curve FRAX Trigger',
      'convexCurve-FRAX-TRIG',
      'Convex Curve FRAX trigger....',
      [3, 12],
      recipient,
      32,
      '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
    ],
    basePool: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', // Curve base pool
  },
  {
    symbol: 'alUSD',
    contract: 'Convex2',
    coinIndices: [0, 1, 2, 3, 4],
    metaIndices: [0, 1],
    poolId: 36,
    triggerParams: [
      'Convex Curve alUSD Trigger',
      'convexCurve-alUSD-TRIG',
      'Convex Curve alUSD trigger....',
      [3, 12],
      recipient,
      36,
      '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
    ],
    basePool: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', // Curve base pool
  },
];

// Define the balanceOf mapping slot number to use for finding the slot used to store balance of a given address
const tokenBalanceOfSlots = {
  '0x1456688345527bE1f37E9e627DA0837D6f08C925': '0x2', // USDP
  '0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490': '0x3', // 3Crv
  '0x6B175474E89094C44Da98b954EedeAC495271d0F': '0x2', // DAI
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': '0x9', // USDC
  '0xdAC17F958D2ee523a2206206994597C13D831ec7': '0x2', // USDT
  '0x8dAEBADE922dF735c38C80C7eBD708Af50815fAa': '0x3', // tBTC
  '0x853d955aCEf822Db058eb8505911ED77F175b99e': '0x0', // FRAX
  '0xBC6DA0FE9aD5f3b0d58160288917AA56653660E9': '0x1', // alUSD
  //
  '0x075b1bb99792c9E1041bA13afEf80C91a1e70fB3': '0x3', // Curve.fi renBTC/wBTC/sBTC
  '0xEB4C2781e4ebA804CE9a9803C67d0893436bB27D': '0x66', // renBTC
  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': '0x0', // Wrapped BTC
  '0x4F6296455F8d754c19821cF1EC8FeBF2cD456E67': '0x3', // Synth sBTC (this is the address of the sBTC storage contract, token address is 0xfE18be6b3Bd88A2D2A7f928d00292E7a9963CfC6)
  '0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B': '0xf', // Curve.fi FRAX/3Crv
  '0x43b4FdFD4Ff969587185cDB6f0BD875c5Fc83f8c': '0xf', // Curve.fi alUSD/3Crv
};

const tokenTotalSupplySlots = {
  '0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490': '0x5', // Curve.fi DAI/USDC/USDT
  '0x7Eb40E450b9655f4B3cC4259BCC731c63ff55ae6': '0x4', // Curve.fi USDP/3Crv
  '0x075b1bb99792c9E1041bA13afEf80C91a1e70fB3': '0x5', // Curve.fi renBTC/wBTC/sBTC
  '0x64eda51d3Ad40D56b9dFc5554E06F94e1Dd786Fd': '0x5', // Curve.fi tBTC/sbtcCrv
  '0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B': '0x11', // Curve.fi FRAX/3Crv
  '0x43b4FdFD4Ff969587185cDB6f0BD875c5Fc83f8c': '0x11', // Curve.fi alUSD/3Crv
};

// Array of Vyper tokens
const vyperTokens = ['0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490', '0x075b1bb99792c9E1041bA13afEf80C91a1e70fB3'];

// --- Helper methods ---
const getStorageSlot = (mappingSlot: string, address: string, isVyper: boolean = false) => {
  return isVyper
    ? hexStripZeros(keccak256(defaultAbiCoder.encode(['uint256', 'address'], [mappingSlot, address])))
    : hexStripZeros(keccak256(defaultAbiCoder.encode(['address', 'uint256'], [address, mappingSlot])));
};

// Gets token balance
async function balanceOf(tokenAddress: string, address: string) {
  const abi = ['function balanceOf(address) external view returns (uint256)'];
  const contract = new ethers.Contract(tokenAddress, abi, ethers.provider);
  return (await contract.balanceOf(address)).toBigInt();
}

pools.forEach((pool) => {
  describe(`Convex: ${pool.symbol}`, function () {
    // --- Data ---
    let deployer: SignerWithAddress;
    let trigger: Contract;
    let crvMeta: Contract;
    let crvBase: Contract;
    let crvMetaToken: Contract;
    let crvBaseToken: Contract;

    // --- Functions modifying storage ---

    // Change Curve pool's virtual price by modifying total supply (since virtual price is a getter method that
    // divides by total token supply)/ To zero out share price, use MAX_UINT256, which simulates unlimited minting of
    // shares, making price per share effectively 0ƒ
    async function setCrvTotalSupply(supply: BigNumberish, poolType: 'base' | 'meta') {
      const token = poolType === 'base' ? crvBaseToken.address : crvMetaToken.address;
      const storageSlot = tokenTotalSupplySlots[token as keyof typeof tokenTotalSupplySlots];
      await network.provider.send('hardhat_setStorageAt', [token, storageSlot, to32ByteHex(supply)]);
    }

    // Modify the balance of a token in the Curve pool by changing it by the specified amount
    async function modifyCrvBalance(tokenAddress: string, account: string, numerator: bigint, denominator: bigint) {
      const value = ((await balanceOf(tokenAddress, account)) * numerator) / denominator;
      const mappingSlot = tokenBalanceOfSlots[tokenAddress as keyof typeof tokenBalanceOfSlots];
      const storageSlot = getStorageSlot(mappingSlot, account, vyperTokens.includes(tokenAddress));
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
      const [deployer] = await ethers.getSigners();

      // Get mainnet contract instances
      // We get the curve LP token addresses from reading storage slots, since they are not exposed with a getter
      const convex = <IConvexBooster>await ethers.getContractAt('IConvexBooster', convexAddress);
      const [curveLpTokenAddress] = await convex.poolInfo(pool.poolId);

      // The meta pool token is the lp token
      const crvMetaToken = await ethers.getContractAt('IERC20', curveLpTokenAddress);

      // Check if this pool uses a Curve factory meta pool - Curve factory meta pools differ from traditional Curve pools
      // in that the meta pool contract is also the LP token contract
      if (pool.contract === 'Convex2') {
        crvMeta = await ethers.getContractAt('ICrvMeta', curveLpTokenAddress);

        // Base pool cannot be determined programmatically for factory pools
        if (pool.basePool) crvBase = await ethers.getContractAt('ICrvBase', pool.basePool);
        else throw Error('Expected pool.basePool to be defined for the test pool');
      } else {
        const crvLpToken = await ethers.getContractAt('ICrvToken', curveLpTokenAddress);
        crvMeta = await ethers.getContractAt('ICrvMeta', await crvLpToken.minter());
        crvBase = await ethers.getContractAt('ICrvBase', await crvMeta.base_pool());
      }

      // The base token contract is the (1) index of the meta pool's coins(uint256 index) function
      const crvBaseTokenAddr = await crvMeta.coins(1);
      const crvBaseToken = await ethers.getContractAt('IERC20', crvBaseTokenAddr);

      // Deploy trigger
      const triggerArtifact = await artifacts.readArtifact(pool.contract);
      const trigger = await deployContract(deployer, triggerArtifact, pool.triggerParams);

      return { deployer, trigger, crvMeta, crvBase, crvMetaToken, crvBaseToken };
    }

    // --- Tests ---
    before(async () => {
      // Ensure mainnet is re-forked before test execution for each protection market to ensure storage slot state isolation
      await reset();
    });

    beforeEach(async () => {
      ({ deployer, trigger, crvMeta, crvBase, crvMetaToken, crvBaseToken } = await loadFixture(setupFixture));
    });

    describe('Deployment', () => {
      it('initializes properly', async () => {
        expect(await trigger.name()).to.equal(pool.triggerParams[0]);
        expect(await trigger.symbol()).to.equal(pool.triggerParams[1]);
        expect(await trigger.description()).to.equal(pool.triggerParams[2]);
        const platformIds = (await trigger.getPlatformIds()).map((id: BigNumber) => id.toNumber());
        expect(platformIds).to.deep.equal(pool.triggerParams[3]); // use `.deep.equal` to compare array equality
        expect(await trigger.recipient()).to.equal(pool.triggerParams[4]);
        expect(await trigger.convexPoolId()).to.equal(pool.triggerParams[5]);
        expect(await trigger.convex()).to.equal(convexAddress);
      });
    });

    describe('checkAndToggleTrigger', () => {
      it('does nothing when called on a valid market', async () => {
        expect(await trigger.isTriggered()).to.be.false;
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.be.false;
      });

      ['base', 'meta'].forEach((poolType) => {
        it(`toggles trigger when called on a broken market: curve ${poolType} pool`, async () => {
          expect(await trigger.isTriggered()).to.be.false;

          await setCrvTotalSupply(MAX_UINT, poolType as 'base' | 'meta');
          expect(await trigger.isTriggered()).to.be.false; // trigger not updated yet, so still expect false

          const tx = await trigger.checkAndToggleTrigger();
          await expect(tx).to.emit(trigger, 'TriggerActivated');
          expect(await trigger.isTriggered()).to.be.true;
        });

        it(`returns a boolean with the value of isTriggered: curve ${poolType} pool`, async () => {
          // Using a helper contract for testing, which has a state variable called isTriggered that stores the last
          // value returned from trigger.checkAndToggleTrigger()
          const mockCozyTokenArtifact = await artifacts.readArtifact('MockCozyToken');
          const mockCozyToken = <MockCozyToken>await deployContract(deployer, mockCozyTokenArtifact, [trigger.address]);
          expect(await mockCozyToken.isTriggered()).to.be.false;

          await setCrvTotalSupply(MAX_UINT, poolType as 'base' | 'meta');
          await mockCozyToken.checkAndToggleTrigger();
          expect(await mockCozyToken.isTriggered()).to.be.true;
        });

        it(`properly accounts for virtual price tolerance: curve ${poolType} pool`, async () => {
          // Modify the currently stored virtual price by a set tolerance
          async function modifyLastVirtualPrice(numerator: bigint, denominator: bigint) {
            const isBase = poolType === 'base';
            const crvPool = isBase ? crvBase : crvMeta;
            const crvToken = isBase ? crvBaseToken : crvMetaToken;
            const vpMethod = isBase ? 'lastVpBasePool' : 'lastVpMetaPool';

            const lastVirtualPrice = (await trigger[vpMethod]()).toBigInt();
            const lastTotalSupply = (await crvToken.totalSupply()).toBigInt();
            const newTotalSupply = (lastTotalSupply * denominator) / numerator;
            const newVirtualPrice = (lastVirtualPrice * numerator) / denominator;
            await setCrvTotalSupply(newTotalSupply, poolType as 'base' | 'meta');
            // Due to rounding error, values may sometimes differ by 1 wei, so validate with a tolerance +/2 wei
            expect(await crvPool.get_virtual_price()).to.be.above(newVirtualPrice - 2n);
            expect(await crvPool.get_virtual_price()).to.be.below(newVirtualPrice + 2n);
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

        // Due to a bug in Smock (https://github.com/defi-wonderland/smock/issues/101) we leave these tests
        // skipped because they cause other tests to fail. Replace the `.skip` with a `.only` to run these
        // tests and verify that they pass
        it.skip(`toggles trigger when ${poolType} pool's get_virtual_price() reverts`, async () => {
          // We force the call to revert by using Smock's Fakes, which are JS objects that emulate a contract.
          // Because they are JS, they can be placed at an arbitrary address, so we place the fake at the
          // address of the Curve pool. We then set the `balances()` calls to return the existing values
          // values so balance checks behave the same, and set `get_virtual_price()` to revert

          // First we generate an array of all possible `balance` function signatures
          const balanceSigs = ['balances(uint256)', 'balances(int128)'];
          const balanceAbi = balanceSigs.map((sig) => `function ${sig} external view returns (uint256)`);

          // Parameters
          const isBase = poolType === 'base';
          const curveTokenIndices = !isBase
            ? pool.metaIndices
            : pool.coinIndices.slice(pool.metaIndices.length).map((i) => i - pool.metaIndices.length);
          const crvPool = isBase ? crvBase : crvMeta;

          // Get existing balances by instantiating the Curve pool with the all `balance` interfaces and
          // filtering out the ones that revert
          const crvPoolBals = new Contract(crvPool.address, balanceAbi, crvPool.provider);
          const balances = await Promise.all(
            curveTokenIndices.map(async (i) => {
              try {
                const bal = await crvPoolBals[balanceSigs[0]](i);
                return bal;
              } catch (e) {
                return await crvPoolBals[balanceSigs[1]](i);
              }
            })
          );

          // Sanity check on initial conditions
          expect(await trigger.isTriggered()).to.be.false;

          // Configure the mock
          // We configure it so any `balances` syntax used returns the existing mainnet values
          const abi = [...balanceAbi, 'function get_virtual_price() external view returns (uint256)'];
          const fakeCrvPool = await smock.fake(abi, { address: crvPool.address });
          balanceSigs.forEach((sig) => balances.forEach((bal, i) => fakeCrvPool[sig].whenCalledWith(i).returns(bal)));
          fakeCrvPool.get_virtual_price.reverts('ahhhhhhh'); // set get_virtual_price() to revert

          // Now we can test the trigger
          await assertTriggerStatus(true);

          // Reset to avoid breaking other tests, since the fake is placed at the mainnet address
          balanceSigs.forEach((sig) => fakeCrvPool[sig].reset());
          fakeCrvPool.get_virtual_price.reset();
        });
      });

      it('toggles trigger when convex totalSupply invariant is violated', async () => {
        await assertTriggerStatus(false);
        const poolId = pool.poolId;
        const convex = await ethers.getContractAt('IConvexBooster', convexAddress, deployer);
        const [_, convexTokenAddr] = await convex.poolInfo(poolId);
        const convexToken = await ethers.getContractAt('IERC20', convexTokenAddr, deployer);

        // Find totalSupply slot programatically
        const ts = await convexToken.totalSupply();
        let slot = '';
        for (const i of Array.from(Array(500).keys())) {
          const val = ethers.BigNumber.from(await ethers.provider.getStorageAt(convexTokenAddr, i));
          if (ts.eq(val)) {
            slot = ethers.utils.hexStripZeros(ethers.BigNumber.from(i).toHexString());
            break;
          }
        }

        // Increase totalSupply by 1 and verify trigger toggles
        await network.provider.send('hardhat_setStorageAt', [convexTokenAddr, slot, to32ByteHex(ts.add(1))]);
        await assertTriggerStatus(true);
      });

      it(`properly updates the saved state`, async () => {
        // Update values (be careful, as setting total too high will cause reverts)
        const baseTotalSupply = await crvBaseToken.totalSupply();
        const metaTotalSupply = await crvMetaToken.totalSupply();
        await setCrvTotalSupply(baseTotalSupply.div(2), 'base');
        await setCrvTotalSupply(metaTotalSupply.div(2), 'meta');

        // Call checkAndToggleTrigger to simulate someone using the protocol
        await trigger.checkAndToggleTrigger();
        expect(await trigger.isTriggered()).to.be.false; // sanity check
        const newVpBase = await crvBase.get_virtual_price();
        const newVpMeta = await crvMeta.get_virtual_price();

        // Verify the new state
        const currentVpBase = await trigger.lastVpBasePool();
        expect(currentVpBase.toString()).to.equal(newVpBase.toString()); // bigint checks are flaky with chai
        const currentVpMeta = await trigger.lastVpMetaPool();
        expect(currentVpMeta.toString()).to.equal(newVpMeta.toString());
      });

      pool.coinIndices.forEach(async (i) => {
        it(`properly accounts for token ${i} balance being drained`, async () => {
          // Get token info
          const isMeta = pool.metaIndices.includes(i);
          const curvePoolAddress = isMeta ? crvMeta.address : crvBase.address;
          const tokenName = `${isMeta ? `metaToken${i}` : `baseToken${i - 2}`}`;
          let tokenAddress = await trigger[tokenName]();

          // sBTC uses a storage contract, so we replace the token address with that
          tokenAddress =
            tokenAddress === '0xfE18be6b3Bd88A2D2A7f928d00292E7a9963CfC6'
              ? '0x4F6296455F8d754c19821cF1EC8FeBF2cD456E67'
              : tokenAddress;

          // Manipulate balances
          const tolerance = (await trigger.balanceTol()).toBigInt();
          // Increase balance to a larger value, should NOT be triggered (sanity check)
          await modifyCrvBalance(tokenAddress, curvePoolAddress, 101n, 100n); // 1% increase
          await assertTriggerStatus(false);
          // Decrease balance by an amount less than tolerance, should NOT be triggered
          await modifyCrvBalance(tokenAddress, curvePoolAddress, 99n, 100n); // 1% decrease
          await assertTriggerStatus(false);
          // Decrease balance by an amount exactly equal to tolerance, should NOT be triggered
          // We add 1 to tolerance to prevent triggering here if balance is an odd number. For example if
          // balance = 11, this will set the balance to 11 // 2 = 5, which will trigger because it's below 5.5
          await modifyCrvBalance(tokenAddress, curvePoolAddress, tolerance + 1n, 1000n);
          await assertTriggerStatus(false);
          // Decrease balance by an amount more than tolerance, should be triggered
          await modifyCrvBalance(tokenAddress, curvePoolAddress, tolerance - 1n, 1000n);
          await assertTriggerStatus(true);
        });
      });
    });
  });
});
