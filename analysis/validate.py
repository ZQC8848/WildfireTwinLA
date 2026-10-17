import unittest
from validate import calibrate, iou, compare, run

class ValidationTests(unittest.TestCase):
    def test_known_calibration(self):
        result=calibrate([0,2,4,None],[{'cell':1,'minutes':10},{'cell':2,'minutes':20},{'cell':3,'minutes':30}],[2,5,10])
        self.assertEqual(result['stepMinutes'],5)
        self.assertEqual(result['samplesExcluded'],1)
    def test_iou_and_reachability(self):
        self.assertEqual(iou([0,10,None],[0,2],5),.5)
        self.assertEqual(compare([0,None],[0,3])['reachabilityDisagreements'],1)
    def test_no_reachable_data(self):
        with self.assertRaises(ValueError): calibrate([None],[{'cell':0,'minutes':2}],[5])
    def test_synthetic_pipeline(self):
        result=run({'arrivalSteps':[0,1,2], 'calibrationDetections':[{'cell':1,'minutes':5}], 'validationDetections':[{'cell':2,'minutes':12}], 'perimeters':[{'minutes':5,'cells':[0,1]}]})
        self.assertEqual(result['perimeters'][0]['iou'],1)
        self.assertEqual(result['heldOut']['detectionProxyMAEMinutes'],2)

if __name__=='__main__': unittest.main()
