// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {QuilcastRecede, IOptIn} from "../src/QuilcastRecede.sol";

contract OptIn is IOptIn {
    mapping(uint256 => bool) public minted;

    function set(uint256 fid, bool on) external {
        minted[fid] = on;
    }
}

contract QuilcastRecedeTest is Test {
    OptIn o = new OptIn();
    QuilcastRecede r = new QuilcastRecede(o, "https://recede.quilcast.com/nft.json", "https://recede.quilcast.com/collection.json", address(this));
    address alice = address(0xA11CE);

    function test_recedesOncePerWalletForVoters() public {
        vm.startPrank(alice);
        vm.expectRevert("no vote to recede");
        r.recede(1356);
        o.set(1356, true);
        r.recede(1356);
        assertEq(r.balanceOf(alice, 1), 1);
        assertEq(r.totalSupply(), 1);
        r.safeTransferFrom(alice, address(0xB0B), 1, 1, "");
        vm.expectRevert("already receded");
        r.recede(1356);
    }

    function test_onlyOwnerMovesMetadata() public {
        r.setURIs("ipfs://a", "ipfs://b");
        assertEq(r.uri(1), "ipfs://a");
        vm.prank(alice);
        vm.expectRevert();
        r.setURIs("x", "y");
    }
}
