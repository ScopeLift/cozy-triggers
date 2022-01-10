# Scripts for determining storage slots, useful for tests

token=0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B # fraxCrv
holder=0x99780beadd209cc3c7282536883ef58f4ff4e52f

# balanceOf
echo "balanceOf..."
for slot in {0..250}; do
  balanceOf=$(seth call $token "balanceOf(address)(uint256)" $holder)
  computedSlot=$(seth index uint256 address $slot $holder) # for Vyper tokens
  # computedSlot=$(seth index address uint256 $holder $slot)
  storageSlotVal=$(seth --to-dec $(seth storage $token $computedSlot))
  [[ $balanceOf -eq $storageSlotVal ]] && { echo "token balanceOf():" $balanceOf; echo "balanceOf storageSlotVal:" $storageSlotVal; }
  [[ $balanceOf -eq $storageSlotVal ]] && { echo "balanceOf MAPPING SLOT:" $slot; break; }
done

echo "================================"

# totalSupply
echo "totalSupply..."
for slot in {0..250}; do
  totalSupply=$(seth call $token "totalSupply()(uint256)")
  storageSlotVal=$(seth --to-dec $(seth storage $token $slot))
  [[ $totalSupply -eq $storageSlotVal ]] && { echo "token totalSupply():" $totalSupply; echo "totalSupply storageSlotVal:" $storageSlotVal; }
  [[ $totalSupply -eq $storageSlotVal ]] && { echo "totalSupply MAPPING SLOT:" $slot; break; }
done

exit 1;