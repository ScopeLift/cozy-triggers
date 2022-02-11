convex=0xF403C135812408BFbE8713b5A23a04b3D48AAE31 # Convex Booster(main deposit contract)
numPools=$(seth call $convex "poolLength()(uint256)")

for i in $(seq 0 "$(($numPools-1))"); do
  resultsString=$(seth call $convex "poolInfo(uint256)(address,address,address,address,address,bool)" $i)
  resultsArray=($resultsString)
  echo "Pool ID" $i
  echo "lpToken" ${resultsArray[0]} $(seth call ${resultsArray[0]} "name()(string)")
  echo "token  " ${resultsArray[1]} $(seth call ${resultsArray[1]} "name()(string)")
  echo ""
done
