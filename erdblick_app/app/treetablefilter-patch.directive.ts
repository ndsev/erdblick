import {AfterContentInit, Directive} from "@angular/core";
import {TreeTable, TreeTableFilterEvent, TreeTableFilterOptions} from "primeng/treetable";
import {TreeTableNode} from "primeng/api";
import {ObjectUtils} from "primeng/utils";

/**
 * This is a monkey-patched version of PrimNG's findFilteredNodes with the following changes:
 *   - Expand matches automatically
 *   - Keep unmatched leaf-node siblings
 *
 * Sadly, ngPrime does not provide a function for matching a single node without recursion,
 * otherwise we could implement this via the `onFilter` subject.
 *
 * For expanding matched nodes, there is https://github.com/primefaces/primeng/issues/7417
 */
@Directive({
    selector: 'p-treeTable'
})
export class TreeTableFilterPatchDirective implements AfterContentInit {
    constructor(private tt: TreeTable) {}

    ngAfterContentInit() {
        this.tt.findFilteredNodes = (node: TreeTableNode<any>, paramsWithoutNode: any) : boolean => {
            console.assert(paramsWithoutNode.isStrictMode);
            if (node) {
                let matched = false;
                if (node.children) {
                    const children = node.children.map(node => { return { ...node }; });
                    node.children = [];

                    let hadMatchingLeaf = false;
                    for (const childNode of children) {
                        if (this.tt.isFilterMatched(childNode, paramsWithoutNode)) {
                            matched = true;
                            hadMatchingLeaf = hadMatchingLeaf || this.tt.isNodeLeaf(childNode);

                            node.children.push(childNode);
                        }
                    }

                    // If we had a matching leaf node, add all leaf nodes.
                    // Since we are in strict mode, if no child matched, add all
                    if (hadMatchingLeaf || !matched) {
                        node.children = children;
                    }
                }

                if (matched) {
                    node.expanded = true;
                    return true;
                }
            }
            return false;
        }
    }
}
