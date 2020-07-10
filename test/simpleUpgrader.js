const ethers = require("ethers");
/* global accounts, utils */
const {
  keccak256, toUtf8Bytes, formatBytes32String, parseBytes32String,
} = require("ethers").utils;
const Proxy = require("../build/Proxy");
const BaseWallet = require("../build/BaseWallet");
const OnlyOwnerModule = require("../build/TestOnlyOwnerModule");
const Module = require("../build/TestModule");
const SimpleUpgrader = require("../build/SimpleUpgrader");
const GuardianManager = require("../build/GuardianManager");
const LockManager = require("../build/LockManager");
const GuardianStorage = require("../build/GuardianStorage");
const Registry = require("../build/ModuleRegistry");
const RecoveryManager = require("../build/RecoveryManager");

const RelayerModule = require("../build/RelayerModule");
const TestManager = require("../utils/test-manager");

const IS_ONLY_OWNER_MODULE = keccak256(toUtf8Bytes("isOnlyOwnerModule()")).slice(0, 10);

describe("SimpleUpgrader", function () {
  this.timeout(10000);

  const manager = new TestManager();

  const owner = accounts[1].signer;
  let deployer;
  let registry;
  let guardianStorage;
  let walletImplementation;
  let wallet;
  let relayerModule;

  before(async () => {
    deployer = manager.newDeployer();
    walletImplementation = await deployer.deploy(BaseWallet);
  });

  beforeEach(async () => {
    registry = await deployer.deploy(Registry);
    guardianStorage = await deployer.deploy(GuardianStorage);

    const proxy = await deployer.deploy(Proxy, {}, walletImplementation.contractAddress);
    wallet = deployer.wrapDeployedContract(BaseWallet, proxy.contractAddress);
    relayerModule = await deployer.deploy(RelayerModule, {},
      registry.contractAddress,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero);
    manager.setRelayerModule(relayerModule);
  });

  describe("Registering modules", () => {
    it("should register modules in the registry", async () => {
      const name = "test_1.1";
      const initialModule = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      await registry.registerModule(initialModule.contractAddress, formatBytes32String(name));
      // Here we adjust how we call isRegisteredModule which has 2 overlaods, one accepting a single address
      // and a second accepting an array of addresses. Behaviour as to which overload is selected to run
      // differs between CI and Coverage environments, adjusted for this here
      const isRegistered = await registry["isRegisteredModule(address)"](initialModule.contractAddress);

      assert.equal(isRegistered, true, "module1 should be registered");
      const info = await registry.moduleInfo(initialModule.contractAddress);
      assert.equal(parseBytes32String(info), name, "module1 should be registered with the correct name");
    });

    it("should add registered modules to a wallet", async () => {
      // create modules
      const initialModule = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      const moduleToAdd = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      // register module
      await registry.registerModule(initialModule.contractAddress, formatBytes32String("initial"));
      await registry.registerModule(moduleToAdd.contractAddress, formatBytes32String("added"));

      await wallet.init(owner.address, [initialModule.contractAddress]);
      let isAuthorised = await wallet.authorised(initialModule.contractAddress);
      assert.equal(isAuthorised, true, "initial module should be authorised");
      // add module to wallet
      await initialModule.from(owner).addModule(wallet.contractAddress, moduleToAdd.contractAddress);

      isAuthorised = await wallet.authorised(moduleToAdd.contractAddress);
      assert.equal(isAuthorised, true, "added module should be authorised");
    });

    it("should block addition of unregistered modules to a wallet", async () => {
      // create modules
      const initialModule = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      const moduleToAdd = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      // register initial module only
      await registry.registerModule(initialModule.contractAddress, formatBytes32String("initial"));

      await wallet.init(owner.address, [initialModule.contractAddress]);
      let isAuthorised = await wallet.authorised(initialModule.contractAddress);
      assert.equal(isAuthorised, true, "initial module should be authorised");
      // try (and fail) to add moduleToAdd to wallet
      await assert.revert(initialModule.from(owner).addModule(wallet.contractAddress, moduleToAdd.contractAddress));
      isAuthorised = await wallet.authorised(moduleToAdd.contractAddress);
      assert.equal(isAuthorised, false, "unregistered module should not be authorised");
    });

    it("should not be able to upgrade to unregistered module", async () => {
      // create module V1
      const moduleV1 = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      // register module V1
      await registry.registerModule(moduleV1.contractAddress, formatBytes32String("V1"));

      await wallet.init(owner.address, [moduleV1.contractAddress]);
      // create module V2
      const moduleV2 = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      // create upgrader
      const upgrader = await deployer.deploy(SimpleUpgrader, {}, registry.contractAddress, [moduleV1.contractAddress], [moduleV2.contractAddress]);
      await registry.registerModule(upgrader.contractAddress, formatBytes32String("V1toV2"));

      // check we can't upgrade from V1 to V2
      await assert.revertWith(moduleV1.from(owner).addModule(wallet.contractAddress, upgrader.contractAddress), "SU: Not all modules are registered");
      // register module V2
      await registry.registerModule(moduleV2.contractAddress, formatBytes32String("V2"));
      // now we can upgrade
      await moduleV1.from(owner).addModule(wallet.contractAddress, upgrader.contractAddress);

      // test if the upgrade worked
      const isV1Authorised = await wallet.authorised(moduleV1.contractAddress);
      const isV2Authorised = await wallet.authorised(moduleV2.contractAddress);
      const isUpgraderAuthorised = await wallet.authorised(upgrader.contractAddress);
      const numModules = await wallet.modules();
      assert.isFalse(isV1Authorised, "moduleV1 should be unauthorised");
      assert.isTrue(isV2Authorised, "moduleV2 should be authorised");
      assert.equal(isUpgraderAuthorised, false, "upgrader should not be authorised");
      assert.equal(numModules, 1, "only one module (moduleV2) should be authorised");
    });
  });

  describe("Upgrading modules", () => {
    async function testUpgradeModule({ relayed, useOnlyOwnerModule, modulesToAdd = (moduleV2) => [moduleV2] }) {
      // create module V1
      let moduleV1;
      if (useOnlyOwnerModule) {
        moduleV1 = await deployer.deploy(OnlyOwnerModule, {}, registry.contractAddress, guardianStorage.contractAddress);
      } else {
        moduleV1 = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      }
      // register module V1
      await registry.registerModule(moduleV1.contractAddress, formatBytes32String("V1"));
      // create wallet with module V1 and relayer module
      const proxy = await deployer.deploy(Proxy, {}, walletImplementation.contractAddress);
      const wallet = deployer.wrapDeployedContract(BaseWallet, proxy.contractAddress);
      await wallet.init(owner.address, [moduleV1.contractAddress, relayerModule.contractAddress]);
      // create module V2
      const moduleV2 = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      // register module V2
      await registry.registerModule(moduleV2.contractAddress, formatBytes32String("V2"));
      // create upgraders
      const toAdd = modulesToAdd(moduleV2.contractAddress);
      const upgrader1 = await deployer.deploy(SimpleUpgrader, {}, registry.contractAddress, [moduleV1.contractAddress], toAdd);
      const upgrader2 = await deployer.deploy(
        SimpleUpgrader,
        {},
        registry.contractAddress,
        [moduleV1.contractAddress, relayerModule.contractAddress],
        toAdd,
      );
      await registry.registerModule(upgrader1.contractAddress, formatBytes32String("V1toV2_1"));
      await registry.registerModule(upgrader2.contractAddress, formatBytes32String("V1toV2_2"));
      // check that module V1 can be used to add the upgrader module
      if (useOnlyOwnerModule) {
        assert.equal(await moduleV1.isOnlyOwnerModule(), IS_ONLY_OWNER_MODULE);
      }

      // upgrade from V1 to V2
      let txReceipt;
      const params1 = [wallet.contractAddress, upgrader1.contractAddress];
      const params2 = [wallet.contractAddress, upgrader2.contractAddress];

      // if no module is added and all modules are removed, the upgrade should fail
      if (toAdd.length === 0) {
        if (relayed) {
          txReceipt = await manager.relay(moduleV1, "addModule", params2, wallet, [owner]);
          const { success } = (await utils.parseLogs(txReceipt, relayerModule, "TransactionExecuted"))[0];
          assert.isTrue(!success, "Relayed upgrade to 0 module should have failed.");
        } else {
          assert.revert(moduleV1.from(owner).addModule(...params2));
        }
        return;
      }

      if (relayed) {
        txReceipt = await manager.relay(moduleV1, "addModule", params1, wallet, [owner]);
        const { success } = (await utils.parseLogs(txReceipt, relayerModule, "TransactionExecuted"))[0];
        assert.equal(success, useOnlyOwnerModule, "Relayed tx should only have succeeded if an OnlyOwnerModule was used");
      } else {
        const tx = await moduleV1.from(owner).addModule(...params1);
        txReceipt = await moduleV1.verboseWaitForTransaction(tx);
      }

      // test event ordering
      const logs = utils.parseLogs(txReceipt, wallet, "AuthorisedModule");
      const upgraderAuthorisedLogIndex = logs.findIndex((e) => e.module === upgrader1.contractAddress && e.value === true);
      const upgraderUnauthorisedLogIndex = logs.findIndex((e) => e.module === upgrader1.contractAddress && e.value === false);
      if (!relayed || useOnlyOwnerModule) {
        assert.isBelow(upgraderAuthorisedLogIndex, upgraderUnauthorisedLogIndex,
          "AuthorisedModule(upgrader, false) should come after AuthorisedModule(upgrader, true)");
      } else {
        assert.equal(upgraderUnauthorisedLogIndex, -1, "AuthorisedModule(upgrader, false) should not have been emitted");
        assert.equal(upgraderAuthorisedLogIndex, -1, "AuthorisedModule(upgrader, true) should not have been emitted");
      }

      // test if the upgrade worked
      const isV1Authorised = await wallet.authorised(moduleV1.contractAddress);
      const isV2Authorised = await wallet.authorised(moduleV2.contractAddress);
      const isUpgraderAuthorised = await wallet.authorised(upgrader1.contractAddress);
      const numModules = await wallet.modules();
      assert.equal(isV1Authorised, relayed && !useOnlyOwnerModule, "moduleV1 should only be unauthorised if the upgrade went through");
      assert.equal(isV2Authorised, !relayed || useOnlyOwnerModule, "moduleV2 should only be authorised if the upgrade went through");
      assert.equal(isUpgraderAuthorised, false, "upgrader should not be authorised");
      assert.equal(numModules, 2, "only two module (moduleV2 and relayerModule) should be authorised");
    }

    it("should upgrade modules (blockchain tx)", async () => {
      await testUpgradeModule({ relayed: false, useOnlyOwnerModule: false });
    });

    it("should upgrade modules (not using OnlyOwnerModule, relayed tx)", async () => {
      await testUpgradeModule({ relayed: true, useOnlyOwnerModule: false });
    });

    it("should upgrade modules (using OnlyOwnerModule, relayed tx)", async () => {
      await testUpgradeModule({ relayed: true, useOnlyOwnerModule: true });
    });

    it("should ignore duplicate modules in upgrader (blockchain tx)", async () => {
      // we intentionally try to add moduleV2 twice to check that it will only be authorised once
      await testUpgradeModule({ relayed: false, useOnlyOwnerModule: false, modulesToAdd: (v2) => [v2, v2] });
    });

    it("should not upgrade to 0 module (blockchain tx)", async () => {
      // we intentionally try to add 0 module, this should fail
      await testUpgradeModule({ relayed: false, useOnlyOwnerModule: true, modulesToAdd: (v2) => [] }); // eslint-disable-line no-unused-vars
    });

    it("should not upgrade to 0 module (relayed tx)", async () => {
      // we intentionally try to add 0 module, this should fail
      await testUpgradeModule({ relayed: true, useOnlyOwnerModule: true, modulesToAdd: (v2) => [] }); // eslint-disable-line no-unused-vars
    });
  });

  describe("Upgrading when wallet is locked", () => {
    let guardianManager;
    let lockManager;
    let recoveryManager;
    let moduleV2;
    const guardian = accounts[2].signer;
    const newowner = accounts[3].signer;

    beforeEach(async () => {
      // Setup the modules for wallet
      guardianManager = await deployer.deploy(GuardianManager, {}, registry.contractAddress, guardianStorage.contractAddress, 24, 12);
      lockManager = await deployer.deploy(LockManager, {}, registry.contractAddress, guardianStorage.contractAddress, 24 * 5);
      recoveryManager = await deployer.deploy(RecoveryManager, {}, registry.contractAddress, guardianStorage.contractAddress, 36, 24 * 5);

      // Setup the wallet with the initial set of modules
      await wallet.init(owner.address, [guardianManager.contractAddress, lockManager.contractAddress, recoveryManager.contractAddress]);
      await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian.address);

      // Setup module v2 for the upgrade
      moduleV2 = await deployer.deploy(Module, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
      await registry.registerModule(moduleV2.contractAddress, formatBytes32String("V2"));
    });

    it("should not be able to upgrade if wallet is locked by guardian", async () => {
      const upgrader = await deployer.deploy(SimpleUpgrader, {}, registry.contractAddress, [lockManager.contractAddress], [moduleV2.contractAddress]);
      await registry.registerModule(upgrader.contractAddress, formatBytes32String("V1toV2"));

      // Guardian locks the wallet
      await lockManager.from(guardian).lock(wallet.contractAddress);

      // Try to upgrade while wallet is locked
      await assert.revertWith(lockManager.from(owner).addModule(wallet.contractAddress, upgrader.contractAddress), "BM: wallet locked");

      // Check wallet is still locked
      const locked = await lockManager.isLocked(wallet.contractAddress);
      assert.isTrue(locked);
      // Check upgrade failed
      const isV1Authorised = await wallet.authorised(lockManager.contractAddress);
      const isV2Authorised = await wallet.authorised(moduleV2.contractAddress);
      assert.isTrue(isV1Authorised);
      assert.isFalse(isV2Authorised);
    });

    it("should not be able to upgrade if wallet is under recovery", async () => {
      const upgrader = await deployer.deploy(
        SimpleUpgrader,
        {},
        registry.contractAddress,
        [recoveryManager.contractAddress],
        [moduleV2.contractAddress],
      );
      await registry.registerModule(upgrader.contractAddress, formatBytes32String("V1toV2"));

      // Put the wallet under recovery
      await manager.relay(recoveryManager, "executeRecovery", [wallet.contractAddress, newowner.address], wallet, [guardian]);

      // Try to upgrade while wallet is under recovery
      await assert.revertWith(recoveryManager.from(owner).addModule(wallet.contractAddress, upgrader.contractAddress), "BM: wallet locked");

      // Check wallet is still locked
      const locked = await lockManager.isLocked(wallet.contractAddress);
      assert.isTrue(locked);
      // Check upgrade failed
      const isV1Authorised = await wallet.authorised(recoveryManager.contractAddress);
      const isV2Authorised = await wallet.authorised(moduleV2.contractAddress);
      assert.isTrue(isV1Authorised);
      assert.isFalse(isV2Authorised);
    });
  });
});
