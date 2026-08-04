import unittest

import numpy as np

from classifier.vote_ladder import add_vote, crop_parent_field, ladder_tile_ids


class ClassifierVoteLadderTest(unittest.TestCase):
    def test_path_starts_with_broad_d8_ancestor(self):
        self.assertEqual(
            ladder_tile_ids("12-1373-784"),
            ["8-85-49", "9-171-98", "10-343-196", "11-686-392", "12-1373-784"],
        )

    def test_parent_votes_crop_using_north_first_quadrants(self):
        parent = np.zeros((1, 4, 4), dtype=np.uint16)
        parent[0, :2, 2:] = 7
        child = crop_parent_field(parent, child_col=1, child_row=1)
        np.testing.assert_array_equal(child, np.full((1, 4, 4), 7))

    def test_votes_accumulate_and_finest_vote_breaks_a_tie(self):
        broad = np.asarray([[0, 0], [1, 1]], dtype=np.uint8)
        votes, winners, confidence = add_vote(None, broad, 3)
        fine = np.asarray([[1, 0], [1, 2]], dtype=np.uint8)
        votes, winners, confidence = add_vote(votes, fine, 3)

        self.assertEqual(votes[:, 0, 0].tolist(), [1, 1, 0])
        self.assertEqual(winners[0, 0], 1)
        self.assertEqual(confidence[0, 0], 128)
        self.assertEqual(winners[0, 1], 0)
        self.assertEqual(confidence[0, 1], 255)
        self.assertEqual(winners[1, 1], 2)


if __name__ == "__main__":
    unittest.main()
