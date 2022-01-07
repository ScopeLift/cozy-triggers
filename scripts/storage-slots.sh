# Scripts for determining storage slots, useful for tests

token=0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B # fraxCrv
holder=0x99780beadd209cc3c7282536883ef58f4ff4e52f

# balanceOf
# for slot in {0..250}; do
#   echo "slot:" $slot
#   balanceOf=$(seth call $token "balanceOf(address)(uint256)" $holder)
#   computedSlot=$(seth index uint256 address $slot $holder) # for Vyper tokens
#   # computedSlot=$(seth index address uint256 $holder $slot)
#   storageSlotVal=$(seth --to-dec $(seth storage $token $computedSlot))
#   [[ $balanceOf -eq $storageSlotVal ]] && { echo "balanceOf:" $balanceOf; echo "storageSlotVal:" $storageSlotVal; }
#   [[ $balanceOf -eq $storageSlotVal ]] && { echo "MAPPING SLOT:" $slot; exit 1; }
# done


# totalSupply
# for slot in {0..250}; do
#   echo "slot:" $slot
#   totalSupply=$(seth call $token "totalSupply()(uint256)" $holder)
#   storageSlotVal=$(seth --to-dec $(seth storage $token $slot))
#   [[ $totalSupply -eq $storageSlotVal ]] && { echo "totalSupply:" $totalSupply; echo "storageSlotVal:" $storageSlotVal; }
#   [[ $totalSupply -eq $storageSlotVal ]] && { echo "MAPPING SLOT:" $slot; exit 1; }
# done

